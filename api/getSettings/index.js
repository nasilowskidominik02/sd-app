const { CosmosClient } = require("@azure/cosmos");

// Inicjalizacja klienta (Singleton)
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    try {
        // Pobieramy dokument konfiguracyjny po ID
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
            // Fallback: jeśli dokument nie istnieje w bazie, zwracamy błąd lub domyślną strukturę
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