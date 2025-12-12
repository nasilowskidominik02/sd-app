const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: [] };
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);
    const userEmail = clientPrincipal.userDetails;

    try {
        // ZMIANA: Używamy StringEquals z trzecim parametrem 'true' (ignoruj wielkość liter)
        // Sprawdzamy pole 'recipient', które jest bezpieczniejsze logicznie
        const querySpec = {
            query: "SELECT * FROM c WHERE c.type = 'notification' AND StringEquals(c.recipient, @userEmail, true) AND c.isRead = false ORDER BY c.createdAt DESC",
            parameters: [{ name: "@userEmail", value: userEmail }]
        };

        const { resources: notifications } = await container.items.query(querySpec).fetchAll();

        context.res = { status: 200, body: notifications };
    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: [] };
    }
};