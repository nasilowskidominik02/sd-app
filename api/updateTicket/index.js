const { CosmosClient } = require("@azure/cosmos");

// Mapa kategorii i przypisanych do nich grup
const categoryToGroupMap = {
    "Instalacja oprogramowania": "Pierwsza linia wsparcia",
    "Konfiguracja oprogramowania": "Pierwsza linia wsparcia",
    "Hardware": "Pierwsza linia wsparcia",
    "Infrastruktura": "Administratorzy infrastruktury",
    "Konto": "Pierwsza linia wsparcia",
    "Aplikacje": "Administratorzy aplikacji",
    "Inne": "Pierwsza linia wsparcia"
};

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: "User not authenticated." };
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    // Tylko pracownicy Service Desk mogą modyfikować zgłoszenia
    if (!clientPrincipal.userRoles.includes('sd')) {
        return { status: 403, body: "You are not authorized to perform this action." };
    }

    const { ticketId, changes } = req.body;
    if (!ticketId || !changes) {
        return { status: 400, body: "Please provide ticketId and changes." };
    }

    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const container = client.database("ServiceDeskDB").container("Tickets");

        const { resource: ticket } = await container.item(ticketId, ticketId).read();
        if (!ticket) {
            return { status: 404, body: "Ticket not found." };
        }

        // Zastosuj zmiany
        if (changes.status) {
            ticket.status = changes.status;
            if (changes.status === 'Zamknięte') {
                ticket.dates.closedAt = new Date().toISOString();
            }
        }
        if (changes.assignedTo) {
            ticket.assignedTo.person = changes.assignedTo.person;
        }
        if (changes.category) {
            ticket.category = changes.category;
            // Automatyczna zmiana grupy na podstawie nowej kategorii
            ticket.assignedTo.group = categoryToGroupMap[changes.category] || "Pierwsza linia wsparcia";
        }

        const { resource: updatedItem } = await container.item(ticketId, ticketId).replace(ticket);

        context.res = { body: updatedItem };

    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: "Error updating the ticket." };
    }
};