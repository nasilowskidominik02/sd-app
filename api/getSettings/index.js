const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

/**
 * Pobiera globalną konfigurację aplikacji Service Desk.
 * * Funkcja jest krytyczna dla procesu inicjalizacji frontendu. Dostarcza strukturę:
 * - Kategorii zgłoszeń (wraz z przypisanymi grupami wsparcia).
 * - Czasów SLA dla poszczególnych priorytetów.
 * - Konfiguracji kalendarza pracy (godziny otwarcia, dni wolne).
 * * Endpoint ten odpytuje bazę o pojedynczy, singletonowy dokument o ID 'global_settings'.
 * Jego brak (404) oznacza, że system nie został poprawnie zainicjalizowany (brak seedowania).
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure (logowanie, odpowiedź).
 * @param {Object} req - Obiekt żądania HTTP (nieużywany w logice, ale wymagany przez sygnaturę).
 * @returns {Object} Odpowiedź HTTP:
 * - 200 OK: Obiekt JSON z ustawieniami.
 * - 404 Not Found: Krytyczny błąd konfiguracji (brak dokumentu ustawień).
 * - 500 Internal Server Error: Błąd połączenia z bazą danych.
 */
module.exports = async function (context, req) {
    try {
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = 'global_settings'"
        };

        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length > 0) {
            context.res = {
                status: 200,
                body: items[0]
            };
        } else {
            // Sytuacja awaryjna: Aplikacja nie będzie działać poprawnie bez ustawień.
            // Frontend powinien obsłużyć ten błąd, wyświetlając komunikat o konserwacji.
            context.res = {
                status: 404,
                body: { message: "Konfiguracja nie została znaleziona." }
            };
        }
    } catch (error) {
        context.log.error("Błąd w getSettings:", error);
        context.res = {
            status: 500,
            body: "Wystąpił błąd podczas pobierania ustawień."
        };
    }
};