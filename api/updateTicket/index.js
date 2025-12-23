const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const ticketsContainer = database.container("Tickets");

// =================================================================================
// 1. DODANO: Funkcja obliczająca SLA (skopiowana z createTicket dla spójności)
// =================================================================================
function calculateAdvancedSLA(startDate, hoursToAdd, workConfig) {
    const startHour = workConfig?.startHour || 8;
    const endHour = workConfig?.endHour || 16;
    const holidays = workConfig?.holidays || [];

    let minutesRemaining = hoursToAdd * 60;
    // Ważne: Tworzymy nowy obiekt daty na podstawie daty startowej
    let currentDate = new Date(startDate); 

    while (minutesRemaining > 0) {
        const dayOfWeek = currentDate.getDay(); 
        const dateString = currentDate.toISOString().split('T')[0];
        const isHoliday = holidays.includes(dateString);
        const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

        if (isWeekend || isHoliday) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        const currentHour = currentDate.getHours();

        if (currentHour < startHour) {
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        if (currentHour >= endHour) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        const endOfWorkDay = new Date(currentDate);
        endOfWorkDay.setHours(endHour, 0, 0, 0);

        const msUntilEndOfDay = endOfWorkDay - currentDate;
        const minutesUntilEndOfDay = Math.floor(msUntilEndOfDay / 60000);

        if (minutesUntilEndOfDay >= minutesRemaining) {
            currentDate.setMinutes(currentDate.getMinutes() + minutesRemaining);
            minutesRemaining = 0;
        } else {
            minutesRemaining -= minutesUntilEndOfDay;
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
        }
    }
    return currentDate;
}
// =================================================================================

async function sendNotification(recipientEmail, message, ticketId) {
    try {
        const normalizedEmail = recipientEmail.toString().toLowerCase().trim();

        await ticketsContainer.items.create({
            id: uuidv4(),
            type: "notification",
            category: normalizedEmail,
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
    if (!header) return { status: 401, body: { message: "User not authenticated." } };
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    if (!clientPrincipal.userRoles.includes('sd')) {
        return { status: 403, body: { message: "Unauthorized." } };
    }

    const { ticketId, changes } = req.body;
    if (!ticketId || !changes) {
        return { status: 400, body: { message: "Missing data." } };
    }

    try {
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
        };
        
        const { resources: items } = await ticketsContainer.items.query(querySpec).fetchAll();
        if (items.length === 0) return { status: 404, body: { message: "Ticket not found." } };
        
        let ticket = items[0];
        const originalCategory = ticket.category;
        const reportingUserEmail = ticket.reportingUser.email;
        const isSelfUpdate = reportingUserEmail.toLowerCase() === clientPrincipal.userDetails.toLowerCase();

        if (ticket.status === 'Zamknięte') {
            const isReopening = changes.status && changes.status === 'Otwarte';
            if (isReopening) {
                 addSystemComment(ticket, `Zmieniono status z "Zamknięte" na "Otwarte".`, clientPrincipal);
                 ticket.status = 'Otwarte';
                 ticket.dates.closedAt = null;
                 if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} otwarte ponownie.`, ticketId);
            } else {
                return { status: 403, body: { message: "Error: Ticket is closed." } };
            }
        } else {
            // ZMIANA STATUSU
            if (changes.status && ticket.status !== changes.status) {
                if (['Rozwiązane', 'Odrzucone'].includes(changes.status)) {
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "Zamknięte".`, clientPrincipal);
                    ticket.status = 'Zamknięte'; 
                    ticket.dates.closedAt = new Date().toISOString();
                    
                    if (!ticket.assignedTo.person) {
                        ticket.assignedTo.person = clientPrincipal.userDetails;
                    }

                    try {
                        const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
                        const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
                        const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;

                        if (globalSettings && globalSettings.groups) {
                            const closingUserEmail = clientPrincipal.userDetails.toLowerCase();
                            const userGroup = globalSettings.groups.find(g => 
                                g.members && g.members.includes(closingUserEmail)
                            );
                            if (userGroup && ticket.assignedTo.group !== userGroup.name) {
                                addSystemComment(ticket, `Automatycznie zmieniono grupę na "${userGroup.name}" (zgodnie z zespołem osoby zamykającej).`, clientPrincipal);
                                ticket.assignedTo.group = userGroup.name;
                            }
                        }
                    } catch (grpErr) {
                        context.log.error("Błąd przy automatycznej zmianie grupy:", grpErr);
                    }

                    if (changes.closingComment) {
                         addSystemComment(ticket, `Dodano komentarz zamknięcia: ${changes.closingComment}`, clientPrincipal);
                    }
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} zostało zamknięte (${changes.status}).`, ticketId);

                } else { 
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "${changes.status}".`, clientPrincipal);
                    ticket.status = changes.status;
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId}: nowy status "${changes.status}".`, ticketId);
                }
            }

            // PRZYPISANIE
            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano zgłoszenie do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;

                if (ticket.status === 'Nieprzeczytane') {
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} przyjęte do realizacji.`, ticketId);
                }
            }

            // =================================================================================
            // 4. ZMIANA KATEGORII (POPRAWIONA LOGIKA)
            // =================================================================================
            if (changes.category && ticket.category !== changes.category) {
                // Pobieramy ustawienia
                const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
                const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
                const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;

                let newGroup = "Pierwsza linia wsparcia";
                let newSlaHours = 8; // Domyślna wartość, jeśli nie znaleziono konfiguracji
                let workConfig = { startHour: 8, endHour: 16, holidays: [] };

                if (globalSettings) {
                    const catConfig = globalSettings.categories.find(c => c.name === changes.category);
                    if (catConfig) {
                        newGroup = catConfig.assignedGroup;
                        newSlaHours = catConfig.sla; // Pobieramy nowe SLA
                    }
                    if (globalSettings.workConfig) {
                        workConfig = globalSettings.workConfig;
                    }
                }

                addSystemComment(ticket, `Zmieniono kategorię z "${ticket.category}" na "${changes.category}".`, clientPrincipal);
                ticket.category = changes.category;
                
                // A. Zmiana Grupy
                if (newGroup !== ticket.assignedTo.group) {
                    addSystemComment(ticket, `Zmieniono grupę odpowiedzialną na: ${newGroup}.`, clientPrincipal);
                    ticket.assignedTo.group = newGroup;
                    if(ticket.assignedTo.person) ticket.assignedTo.person = null;
                }

                // B. NOWOŚĆ: Przeliczenie SLA
                // Używamy daty UTWORZENIA (ticket.dates.createdAt) jako bazy, aby SLA było uczciwe.
                // Jeśli wolisz liczyć czas "od teraz", zmień ticket.dates.createdAt na new Date().
                const newSlaDate = calculateAdvancedSLA(ticket.dates.createdAt, newSlaHours, workConfig);
                ticket.dates.guaranteedResolutionAt = newSlaDate.toISOString();
                
                addSystemComment(ticket, `Zaktualizowano termin SLA (wg nowej kategorii: ${newSlaHours}h).`, clientPrincipal);

                // C. Zmiana statusu jeśli był Nieprzeczytane
                if (ticket.status === 'Nieprzeczytane') { 
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} zakwalifikowane.`, ticketId);
                }
            }

            // KOMENTARZ
            if (changes.newComment) {
                 if (!ticket.comments) ticket.comments = [];
                 ticket.comments.push({
                    author: clientPrincipal.userDetails,
                    text: `Dodano komentarz: ${changes.newComment.text}`, 
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
        context.res = { status: 500, body: { message: "Error updating ticket." } };
    }
};