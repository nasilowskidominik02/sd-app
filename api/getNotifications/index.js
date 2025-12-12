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
        // DEBUG: Logujemy w konsoli Azure co się dzieje
        context.log(`Pobieram powiadomienia dla: ${userEmail}`);

        // ZMIANA:
        // 1. Używamy LOWER() zamiast StringEquals (bardziej niezawodne w SQL API)
        // 2. Usunąłem ORDER BY na chwilę, aby wykluczyć problemy z indeksami
        const querySpec = {
            query: "SELECT * FROM c WHERE c.type = 'notification' AND LOWER(c.recipient) = LOWER(@userEmail) AND c.isRead = false",
            parameters: [{ name: "@userEmail", value: userEmail }]
        };

        const { resources: notifications } = await container.items.query(querySpec).fetchAll();
        
        // Sortujemy w JS, żeby nie obciążać bazy, jeśli indeksy są problemem
        notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        context.log(`Znaleziono: ${notifications.length} powiadomień.`);

        context.res = {
            status: 200,
            body: notifications
        };
    } catch (error) {
        context.log.error("Błąd w getNotifications:", error);
        context.res = { status: 500, body: [] };
    }
};