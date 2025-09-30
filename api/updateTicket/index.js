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

        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
        };
        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length === 0) {
            return { status: 404, body: "Ticket not found." };
        }
        let ticket = items[0];
        const originalCategory = ticket.category; // Zapisujemy oryginalną kategorię (klucz partycji)

        if (!ticket.comments) {
            ticket.comments = [];
        }

        // Zastosuj zmiany
        let categoryChanged = false;
        if (changes.status) {
            ticket.status = changes.status;
            if (changes.status === 'Zamknięte' && !ticket.dates.closedAt) {
                ticket.dates.closedAt = new Date().toISOString();
                if (changes.newComment && changes.newComment.text) {
                    ticket.comments.push({
                        author: clientPrincipal.userDetails,
                        text: changes.newComment.text,
                        timestamp: new Date().toISOString()
                    });
                }
            } else if (changes.status !== 'Zamknięte') {
                ticket.dates.closedAt = null;
            }
        }
        if (changes.assignedTo && changes.assignedTo.person) {
            ticket.assignedTo.person = changes.assignedTo.person;
        }
        if (changes.category && changes.category !== originalCategory) {
            const newCategory = changes.category;
            const newGroup = categoryToGroupMap[newCategory] || "Pierwsza linia wsparcia";
            
            ticket.category = newCategory;
            ticket.assignedTo.group = newGroup;
            categoryChanged = true;

            // NOWA LOGIKA: Jeśli nowa grupa jest inna niż "Pierwsza linia wsparcia",
            // czyścimy przypisanie do konkretnej osoby.
            if (newGroup !== "Pierwsza linia wsparcia") {
                ticket.assignedTo.person = null;
            }
        }
        if (changes.newComment && changes.newComment.text && changes.status !== 'Zamknięte') {
             ticket.comments.push({
                author: clientPrincipal.userDetails,
                text: changes.newComment.text,
                timestamp: new Date().toISOString()
            });
        }

        let updatedItem;

        if (categoryChanged) {
            // Jeśli klucz partycji (kategoria) się zmienił, musimy usunąć stary dokument i stworzyć nowy.
            await container.items.create(ticket);
            await container.item(ticket.id, originalCategory).delete();
            updatedItem = ticket;
        } else {
            // Jeśli kategoria się nie zmieniła, po prostu aktualizujemy istniejący dokument.
            const { resource } = await container.items.upsert(ticket);
            updatedItem = resource;
        }

        context.res = { body: updatedItem };

    } catch (error) {
        context.log.error("Error in updateTicket:", error);
        context.res = { status: 500, body: "Error updating the ticket." };
    }
};

