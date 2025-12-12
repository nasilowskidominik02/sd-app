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
    const userEmail = clientPrincipal.userDetails;

    try {
        // 1. Normalizacja: małe litery + usunięcie spacji (tak jak przy zapisie)
        const userEmailLower = userEmail.toLowerCase().trim();

        // 2. Zapytanie po kluczu partycji
        const querySpec = {
            query: "SELECT * FROM c WHERE c.type = 'notification' AND c.category = @userEmailLower AND c.isRead = false",
            parameters: [{ name: "@userEmailLower", value: userEmailLower }]
        };

        const { resources: notifications } = await container.items.query(querySpec).fetchAll();
        
        // Sortowanie (najnowsze na górze)
        notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        context.res = {
            status: 200,
            body: notifications,
            headers: {
                // KLUCZOWE: Wyłączenie cache'owania w przeglądarce
                "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                "Pragma": "no-cache",
                "Expires": "0",
                "Surrogate-Control": "no-store"
            }
        };
    } catch (error) {
        context.log.error("Błąd w getNotifications:", error);
        context.res = { status: 500, body: [] };
    }
};