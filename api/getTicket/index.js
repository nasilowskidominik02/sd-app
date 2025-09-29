const { CosmosClient } = require("@azure/cosmos");

module.exports = async function (context, req) {
    const ticketId = req.query.id;

    if (!ticketId) {
        context.res = { status: 400, body: "Please provide a ticket ID." };
        return;
    }

    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const container = client.database("ServiceDeskDB").container("Tickets");

        // ZMIANA: Używamy zapytania SQL, aby znaleźć element po ID, 
        // co jest bardziej niezawodne niż próba bezpośredniego odczytu bez klucza partycji.
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [
                { name: "@ticketId", value: ticketId }
            ]
        };

        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length > 0) {
            // Zwracamy pierwszy znaleziony element (powinien być tylko jeden)
            context.res = { body: items[0] };
        } else {
            context.res = { status: 404, body: "Ticket not found." };
        }
    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: "Error reading from the database." };
    }
};

