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

/**
 * Funkcja pomocnicza do dodawania komentarza systemowego do historii zgłoszenia.
 */
function addSystemComment(ticket, text, clientPrincipal) {
    if (!ticket.comments) {
        ticket.comments = [];
    }
    ticket.comments.push({
        author: `System (${clientPrincipal.userDetails})`,
        text: text,
        timestamp: new Date().toISOString(),
        isSystemComment: true
    });
}

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: { message: "User not authenticated." } };
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    if (!clientPrincipal.userRoles.includes('sd')) {
        return { status: 403, body: { message: "You are not authorized to perform this action." } };
    }

    const { ticketId, changes } = req.body;
    if (!ticketId || !changes) {
        return { status: 400, body: { message: "Please provide ticketId and changes." } };
    }

    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const container = client.database("ServiceDeskDB").container("Tickets");

        // KROK 1: Niezawodnie znajdź zgłoszenie po ID, używając zapytania
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
        };
        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length === 0) {
            return { status: 404, body: { message: "Ticket not found." } };
        }
        let ticket = items[0];
        const originalCategory = ticket.category; // Zapisz oryginalną kategorię do późniejszego porównania

        // KROK 2: Zastosuj zmiany w zależności od statusu zgłoszenia
        const isClosed = ['Rozwiązane', 'Odrzucone'].includes(ticket.status);
        if (isClosed) {
            const isReopening = changes.status && changes.status === 'Otwarte';
            if (isReopening) {
                 addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "Otwarte".`, clientPrincipal);
                 ticket.status = 'Otwarte';
                 ticket.dates.closedAt = null;
            } else {
                return { status: 403, body: { message: "Zgłoszenie musi mieć status 'Otwarte', aby można było je modyfikować." } };
            }
        } else {
            // Standardowa logika dla otwartych zgłoszeń
            if (changes.status && ticket.status !== changes.status) {
                addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "${changes.status}".`, clientPrincipal);
                ticket.status = changes.status;
                if (['Rozwiązane', 'Odrzucone'].includes(changes.status)) {
                    ticket.dates.closedAt = new Date().toISOString();
                }
            }

            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano zgłoszenie do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;
            }

            if (changes.category && ticket.category !== changes.category) {
                addSystemComment(ticket, `Zmieniono kategorię z "${ticket.category}" na "${changes.category}".`, clientPrincipal);
                ticket.category = changes.category;
                
                const newGroup = categoryToGroupMap[changes.category] || "Pierwsza linia wsparcia";
                if (newGroup !== ticket.assignedTo.group) {
                    addSystemComment(ticket, `Zmieniono grupę odpowiedzialną na: ${newGroup}.`, clientPrincipal);
                    ticket.assignedTo.group = newGroup;
                    if(ticket.assignedTo.person){
                        addSystemComment(ticket, `Usunięto przypisanie osoby z powodu zmiany grupy.`, clientPrincipal);
                        ticket.assignedTo.person = null;
                    }
                }
            }

            if (changes.newComment) {
                 if (!ticket.comments) ticket.comments = [];
                 ticket.comments.push({
                    author: clientPrincipal.userDetails,
                    text: changes.newComment.text,
                    timestamp: new Date().toISOString(),
                    attachment: changes.newComment.attachment || null
                });
            }
        }
        
        // KROK 3: Zapisz zmiany, obsługując poprawnie zmianę klucza partycji
        if (ticket.category !== originalCategory) {
            // Jeśli kategoria (klucz partycji) się zmieniła, musimy usunąć stary dokument i stworzyć nowy
            const { resource: createdItem } = await container.items.create(ticket);
            await container.item(ticketId, originalCategory).delete();
            context.res = { body: createdItem };
        } else {
            // Standardowa aktualizacja w obrębie tej samej partycji
            const { resource: updatedItem } = await container.items.upsert(ticket);
            context.res = { body: updatedItem };
        }

    } catch (error) {
        context.log.error("Error in updateTicket:", error.stack);
        context.res = { status: 500, body: { message: "Wystąpił błąd podczas aktualizacji zgłoszenia." } };
    }
};

