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
    
    // Normalizacja e-maila
    const searchEmail = rawUserEmail.toLowerCase().trim();

    try {
        // Zapytanie szukające po kluczu partycji (category) ORAZ recipient (dla pewności)
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
        
        notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        context.res = {
            status: 200,
            body: notifications,
            headers: {
                "Cache-Control": "no-store, no-cache, must-revalidate",
                "Expires": "0"
            }
        };
    } catch (error) {
        context.log.error("Błąd w getNotifications:", error);
        context.res = { status: 500, body: [] };
    }
};