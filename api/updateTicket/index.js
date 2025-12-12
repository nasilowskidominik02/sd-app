const { CosmosClient } = require("@azure/cosmos");

// Inicjalizacja połączenia poza funkcją (Singleton)
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

// UWAGA: Usunęliśmy sztywną mapę categoryToGroupMap. Teraz będziemy pobierać to z bazy.

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
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
        };
        
        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length === 0) {
            return { status: 404, body: { message: "Ticket not found." } };
        }
        let ticket = items[0];
        const originalCategory = ticket.category;

        // Logika sprawdzająca status zgłoszenia
        if (ticket.status === 'Zamknięte') {
            const isReopening = changes.status && changes.status === 'Otwarte';
            if (isReopening) {
                 addSystemComment(ticket, `Zmieniono status z "Zamknięte" na "Otwarte".`, clientPrincipal);
                 ticket.status = 'Otwarte';
                 ticket.dates.closedAt = null;
            } else {
                return { status: 403, body: { message: "Zgłoszenie musi mieć status 'Otwarte', aby można było je modyfikować." } };
            }
        } else {
            // Zmiana statusu
            if (changes.status && ticket.status !== changes.status) {
                if (['Rozwiązane', 'Odrzucone'].includes(changes.status)) {
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "Zamknięte".`, clientPrincipal);
                    ticket.status = 'Zamknięte'; 
                    ticket.dates.closedAt = new Date().toISOString();
                    
                    // Automatyczne przypisanie osoby zamykającej, jeśli nikt nie jest przypisany
                    if (!ticket.assignedTo.person) {
                        ticket.assignedTo.person = clientPrincipal.userDetails;
                        addSystemComment(ticket, `Automatycznie przypisano zgłoszenie do: ${clientPrincipal.userDetails} (osoba zamykająca).`, clientPrincipal);
                    }

                    if (changes.closingComment) {
                         addSystemComment(ticket, changes.closingComment, clientPrincipal);
                    }
                } else { 
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "${changes.status}".`, clientPrincipal);
                    ticket.status = changes.status;
                }
            }

            // Zmiana osoby przypisanej
            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano zgłoszenie do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;

                if (ticket.status === 'Nieprzeczytane') {
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                }
            }

            // Zmiana kategorii (TERAZ DYNAMICZNA)
            if (changes.category && ticket.category !== changes.category) {
                // KROK 1: Pobieramy ustawienia z bazy, aby wiedzieć jaka grupa odpowiada nowej kategorii
                const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
                const { resources: settingsItems } = await container.items.query(settingsQuery).fetchAll();
                const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;

                let newGroup = "Pierwsza linia wsparcia"; // Wartość domyślna (fallback)
                
                if (globalSettings) {
                    const catConfig = globalSettings.categories.find(c => c.name === changes.category);
                    if (catConfig) {
                        newGroup = catConfig.assignedGroup;
                    }
                }

                addSystemComment(ticket, `Zmieniono kategorię z "${ticket.category}" na "${changes.category}".`, clientPrincipal);
                ticket.category = changes.category;
                
                // KROK 2: Aktualizujemy grupę na podstawie pobranej konfiguracji
                if (newGroup !== ticket.assignedTo.group) {
                    addSystemComment(ticket, `Zmieniono grupę odpowiedzialną na: ${newGroup}.`, clientPrincipal);
                    ticket.assignedTo.group = newGroup;
                    if(ticket.assignedTo.person){
                        addSystemComment(ticket, `Usunięto przypisanie osoby z powodu zmiany grupy.`, clientPrincipal);
                        ticket.assignedTo.person = null;
                    }
                }

                if (ticket.status === 'Nieprzeczytane') { 
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                }
            }

            // Dodawanie komentarza
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
        
        // Zapis zmian (z obsługą zmiany Partition Key przy zmianie kategorii)
        if (ticket.category !== originalCategory) {
            const { resource: createdItem } = await container.items.create(ticket);
            await container.item(ticketId, originalCategory).delete();
            context.res = { body: createdItem };
        } else {
            const { resource: updatedItem } = await container.items.upsert(ticket);
            context.res = { body: updatedItem };
        }

    } catch (error) {
        context.log.error("Error in updateTicket:", error.stack);
        context.res = { status: 500, body: { message: "Wystąpił błąd podczas aktualizacji zgłoszenia." } };
    }
};