const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const ticketId = req.query.id;
    
    if (!ticketId) {
        context.res = { status: 400, body: "Please pass a ticket id on the query string" };
        return;
    }

    try {
        // WAŻNE: SELECT * pobiera też pola systemowe (_etag, _ts), które są kluczowe dla blokady!
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: ticketId }]
        };

        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length === 0) {
            context.res = { status: 404, body: "Ticket not found" };
        } else {
            // Zwracamy cały obiekt, łącznie z _etag
            context.res = { body: items[0] };
        }
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};