const { CosmosClient } = require("@azure/cosmos");

module.exports = async function (context, req) {
    const ticketId = req.query.id;

    if (!ticketId) {
        return { status: 400, body: "Please provide a ticket ID." };
    }

    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const container = client.database("ServiceDeskDB").container("Tickets");

        // Użyj partycji, aby odczyt był wydajniejszy - zakładając, że ID zgłoszenia jest też kluczem partycji.
        // Jeśli kluczem partycji jest np. kategoria, to trzeba by go też przekazać.
        // Dla prostoty zakładamy, że ID jest kluczem partycji.
        const { resource: ticket } = await container.item(ticketId, ticketId).read();

        if (ticket) {
            context.res = { body: ticket };
        } else {
            context.res = { status: 404, body: "Ticket not found." };
        }
    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: "Error reading from the database." };
    }
};