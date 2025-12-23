const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

/**
 * Główna funkcja Azure Function pobierająca nieprzeczytane powiadomienia dla użytkownika.
 * * Realizuje następujące zadania:
 * 1. Autoryzacja użytkownika na podstawie nagłówka SWA (Static Web Apps).
 * 2. Normalizacja adresu e-mail (lowercase/trim), aby uniknąć problemów z wielkością liter przy wyszukiwaniu.
 * 3. Pobranie z bazy danych tylko aktywnych (nieprzeczytanych) powiadomień skierowanych do danego odbiorcy.
 * 4. Sortowanie wyników od najnowszych do najstarszych.
 * 5. Wymuszenie nagłówków "No-Cache", aby frontend zawsze otrzymywał świeży stan powiadomień.
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure (logowanie, odpowiedź).
 * @param {Object} req - Obiekt żądania HTTP.
 * @returns {Object} Odpowiedź HTTP zawierająca tablicę powiadomień (JSON) lub pustą tablicę w przypadku błędu.
 */
module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        // Zwracamy pustą tablicę zamiast błędu, aby nie "psuć" UI, jeśli sesja wygasła
        return { status: 401, body: [] };
    }
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);
    const rawUserEmail = clientPrincipal.userDetails;
    
    // Normalizacja e-maila jest krytyczna, ponieważ różne systemy logowania (AAD, Google)
    // mogą zwracać adresy w różnej wielkości liter.
    const searchEmail = rawUserEmail.toLowerCase().trim();

    try {
        // Konstrukcja zapytania SQL do Cosmos DB.
        // Szukamy po kluczu partycji (category) ORAZ polu recipient dla pewności spójności danych.
        // Filtrujemy tylko typ 'notification' i status isRead=false.
        const querySpec = {
            query: `
                SELECT * FROM c 
                WHERE c.type = 'notification' 
                AND c.isRead = false
                AND (c.category = @email OR LOWER(c.recipient) = @email)
            `,
            parameters: [{ name: "@email", value: searchEmail }]
        };

        const { resources: notifications } = await container.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();
        
        // Sortowanie w pamięci (JavaScript) jest tu wydajniejsze i tańsze (RU) 
        // niż skomplikowane ORDER BY w Cosmos DB dla relatywnie małej listy powiadomień.
        notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        context.res = {
            status: 200,
            body: notifications,
            headers: {
                // Wyłączamy cache przeglądarki, ponieważ powiadomienia zmieniają się dynamicznie
                // i użytkownik musi widzieć aktualny stan natychmiast po kliknięciu.
                "Cache-Control": "no-store, no-cache, must-revalidate",
                "Expires": "0"
            }
        };
    } catch (error) {
        context.log.error("Błąd w getNotifications:", error);
        // Fail-safe: W razie awarii bazy zwracamy pustą listę, aby aplikacja działała dalej
        context.res = { status: 500, body: [] };
    }
};