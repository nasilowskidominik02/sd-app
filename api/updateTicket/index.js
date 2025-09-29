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

        // Używamy zapytania, aby niezawodnie znaleźć zgłoszenie po jego ID
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
        };
        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length === 0) {
            return { status: 404, body: "Ticket not found." };
        }
        let ticket = items[0];

        // Zawsze inicjuj tablicę komentarzy, jeśli nie istnieje
        if (!ticket.comments) {
            ticket.comments = [];
        }

        // Zastosuj zmiany na pobranym dokumencie
        if (changes.status) {
            ticket.status = changes.status;
            // Jeśli ustawiamy status na "Zamknięte", dodaj datę zamknięcia.
            if (changes.status === 'Zamknięte' && !ticket.dates.closedAt) {
                ticket.dates.closedAt = new Date().toISOString();
                 // Dodaj komentarz zamknięcia, jeśli jest dostępny
                if (changes.newComment && changes.newComment.text.includes("Zgłoszenie zamknięte")) {
                    ticket.comments.push({
                        author: clientPrincipal.userDetails,
                        text: changes.newComment.text,
                        timestamp: new Date().toISOString()
                    });
                }
            } 
            // Jeśli ustawiamy status na inny niż "Zamknięte" (np. "Otwarte"),
            // upewnij się, że data zamknięcia jest pusta (null).
            else if (changes.status !== 'Zamknięte') {
                ticket.dates.closedAt = null;
            }
        }
        if (changes.assignedTo && changes.assignedTo.person) {
            ticket.assignedTo.person = changes.assignedTo.person;
        }
        if (changes.category) {
            ticket.category = changes.category;
            // Automatyczna zmiana grupy na podstawie nowej kategorii
            ticket.assignedTo.group = categoryToGroupMap[changes.category] || "Pierwsza linia wsparcia";
        }
        // Dodaj nowy, standardowy komentarz
        if (changes.newComment && !changes.newComment.text.includes("Zgłoszenie zamknięte")) {
             ticket.comments.push({
                author: clientPrincipal.userDetails,
                text: changes.newComment.text,
                timestamp: new Date().toISOString()
            });
        }

        const { resource: updatedItem } = await container.items.upsert(ticket);

        context.res = { body: updatedItem };

    } catch (error) {
        context.log.error("Error in updateTicket:", error);
        context.res = { status: 500, body: "Error updating the ticket." };
    }
};

