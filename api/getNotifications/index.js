const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: [] };
    }
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);
    const rawUserEmail = clientPrincipal.userDetails;
    
    // Normalizujemy email (tak jak w kodzie zapisu)
    const normalizedEmail = rawUserEmail.toLowerCase().trim();

    try {
        // TESTOWE ZAPYTANIE: Pobierz jakiekolwiek 3 powiadomienia z bazy (bez filtrowania użytkownika!)
        // To sprawdzi, czy w ogóle mamy dostęp do tych danych.
        const querySpec = {
            query: "SELECT TOP 3 * FROM c WHERE c.type = 'notification'"
        };

        // Używamy cross-partition query, żeby przeszukać wszystko
        const { resources: anyNotifications } = await container.items.query(querySpec, { enableCrossPartitionQuery: true }).fetchAll();

        // TWORZYMY RAPORT DIAGNOSTYCZNY
        const diagnosticMessage = {
            id: "diag-1",
            message: `DIAGNOSTYKA: Zalogowany jako: '${rawUserEmail}'. Szukam klucza: '${normalizedEmail}'. Czy widzę cokolwiek w bazie? ${anyNotifications.length > 0 ? 'TAK' : 'NIE'}`,
            ticketId: null,
            createdAt: new Date().toISOString(),
            isRead: false
        };

        // Zwracamy raport + to co znaleźliśmy w bazie (jeśli znaleźliśmy)
        // Jeśli baza zwróciła wyniki, ale nie Twoje - zobaczysz to tutaj.
        const results = [diagnosticMessage, ...anyNotifications];

        context.res = {
            status: 200,
            body: results,
            headers: {
                "Cache-Control": "no-store, no-cache",
                "Expires": "0"
            }
        };
    } catch (error) {
        context.res = { 
            status: 200, 
            body: [{
                id: "error",
                message: `BŁĄD KRYTYCZNY DB: ${error.message}`,
                createdAt: new Date().toISOString(),
                isRead: false
            }] 
        };
    }
};