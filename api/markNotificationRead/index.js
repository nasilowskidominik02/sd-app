const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: "Unauthorized" };
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);
    
    const { id } = req.body;
    if (!id) return { status: 400, body: "Missing ID" };

    try {
        // Klucz partycji dla powiadomień to e-mail użytkownika (zapisany w polu category)
        const { resource: notification } = await container.item(id, clientPrincipal.userDetails).read();

        if (notification && notification.type === 'notification') {
            notification.isRead = true;
            await container.items.upsert(notification);
        }

        context.res = { status: 200, body: "OK" };
    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: "Error" };
    }
};