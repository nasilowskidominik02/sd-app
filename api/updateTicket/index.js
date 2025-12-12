const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

// Używamy TYLKO kontenera Tickets
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const ticketsContainer = database.container("Tickets");

// Funkcja zapisuje powiadomienie w kontenerze Tickets
async function sendNotification(recipientEmail, message, ticketId) {
    try {
        await ticketsContainer.items.create({
            id: uuidv4(),
            type: "notification", // Ważne: oznaczamy typ dokumentu
            category: recipientEmail, // Używamy maila jako kategorii (dla Partition Key)
            recipient: recipientEmail,
            ticketId: ticketId,
            message: message,
            isRead: false,
            createdAt: new Date().toISOString()
        });
    } catch (error) {
        console.error("Błąd podczas wysyłania powiadomienia:", error);
    }
}

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
        
        const { resources: items } = await ticketsContainer.items.query(querySpec).fetchAll();

        if (items.length === 0) {
            return { status: 404, body: { message: "Ticket not found." } };
        }
        let ticket = items[0];
        const originalCategory = ticket.category;
        const reportingUserEmail = ticket.reportingUser.email;
        const isSelfUpdate = reportingUserEmail === clientPrincipal.userDetails;

        // Logika statusów i powiadomień
        if (ticket.status === 'Zamknięte') {
            const isReopening = changes.status && changes.status === 'Otwarte';
            if (isReopening) {
                 addSystemComment(ticket, `Zmieniono status z "Zamknięte" na "Otwarte".`, clientPrincipal);
                 ticket.status = 'Otwarte';
                 ticket.dates.closedAt = null;
                 
                 if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Twoje zgłoszenie #${ticketId} zostało ponownie otwarte.`, ticketId);
            } else {
                return { status: 403, body: { message: "Zgłoszenie musi mieć status 'Otwarte', aby można było je modyfikować." } };
            }
        } else {
            if (changes.status && ticket.status !== changes.status) {
                if (['Rozwiązane', 'Odrzucone'].includes(changes.status)) {
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "Zamknięte".`, clientPrincipal);
                    ticket.status = 'Zamknięte'; 
                    ticket.dates.closedAt = new Date().toISOString();
                    
                    if (!ticket.assignedTo.person) {
                        ticket.assignedTo.person = clientPrincipal.userDetails;
                        addSystemComment(ticket, `Automatycznie przypisano zgłoszenie do: ${clientPrincipal.userDetails} (osoba zamykająca).`, clientPrincipal);
                    }

                    if (changes.closingComment) {
                         addSystemComment(ticket, changes.closingComment, clientPrincipal);
                    }
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Twoje zgłoszenie #${ticketId} zostało zamknięte (${changes.status}).`, ticketId);

                } else { 
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "${changes.status}".`, clientPrincipal);
                    ticket.status = changes.status;
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Status zgłoszenia #${ticketId} zmienił się na "${changes.status}".`, ticketId);
                }
            }

            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano zgłoszenie do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;

                if (ticket.status === 'Nieprzeczytane') {
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Twoje zgłoszenie #${ticketId} jest w realizacji (Otwarte).`, ticketId);
                }
            }

            if (changes.category && ticket.category !== changes.category) {
                // Pobieranie ustawień z tego samego kontenera Tickets
                const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
                const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
                const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;

                let newGroup = "Pierwsza linia wsparcia";
                if (globalSettings) {
                    const catConfig = globalSettings.categories.find(c => c.name === changes.category);
                    if (catConfig) newGroup = catConfig.assignedGroup;
                }

                addSystemComment(ticket, `Zmieniono kategorię z "${ticket.category}" na "${changes.category}".`, clientPrincipal);
                ticket.category = changes.category;
                
                if (newGroup !== ticket.assignedTo.group) {
                    addSystemComment(ticket, `Zmieniono grupę odpowiedzialną na: ${newGroup}.`, clientPrincipal);
                    ticket.assignedTo.group = newGroup;
                    if(ticket.assignedTo.person) ticket.assignedTo.person = null;
                }

                if (ticket.status === 'Nieprzeczytane') { 
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Twoje zgłoszenie #${ticketId} zostało zakwalifikowane.`, ticketId);
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
                if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Nowy komentarz w zgłoszeniu #${ticketId}.`, ticketId);
            }
        }
        
        if (ticket.category !== originalCategory) {
            const { resource: createdItem } = await ticketsContainer.items.create(ticket);
            await ticketsContainer.item(ticketId, originalCategory).delete();
            context.res = { body: createdItem };
        } else {
            const { resource: updatedItem } = await ticketsContainer.items.upsert(ticket);
            context.res = { body: updatedItem };
        }

    } catch (error) {
        context.log.error("Error in updateTicket:", error.stack);
        context.res = { status: 500, body: { message: "Wystąpił błąd podczas aktualizacji zgłoszenia." } };
    }
};