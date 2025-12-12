const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: "Unauthorized" };
    
    // 1. Pobieramy ID oraz PartitionKey (Category) z żądania
    const { id, partitionKey } = req.body;
    
    if (!id || !partitionKey) {
        context.log("Błąd markNotificationRead: Brak ID lub PartitionKey");
        return { status: 400, body: "Missing ID or PartitionKey" };
    }

    try {
        // 2. Pobieramy konkretne powiadomienie używając klucza partycji
        const { resource: notification } = await container.item(id, partitionKey).read();

        if (notification && notification.type === 'notification') {
            // 3. Oznaczamy jako przeczytane i zapisujemy
            notification.isRead = true;
            await container.items.upsert(notification);
            context.res = { status: 200, body: "OK" };
        } else {
            context.res = { status: 404, body: "Notification not found" };
        }
    } catch (error) {
        context.log.error("Błąd markNotificationRead:", error);
        context.res = { status: 500, body: "Error" };
    }
};