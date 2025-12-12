const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: "Unauthorized" };
    
    // Pobieramy dane z body
    const { id, partitionKey } = req.body;
    
    if (!id || !partitionKey) return { status: 400, body: "Missing ID or PartitionKey" };

    try {
        // Używamy przekazanego klucza partycji (np. "Patrycja.Lach@techserv.pl")
        // aby bezbłędnie trafić w dokument, niezależnie od tego jak user jest zalogowany
        const { resource: notification } = await container.item(id, partitionKey).read();

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