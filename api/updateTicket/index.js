const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const ticketsContainer = database.container("Tickets");

// Funkcja pomocnicza do obliczania SLA
function calculateAdvancedSLA(startDate, hoursToAdd, workConfig) {
    const startHour = workConfig?.startHour || 8;
    const endHour = workConfig?.endHour || 16;
    const holidays = workConfig?.holidays || [];

    let minutesRemaining = hoursToAdd * 60;
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
        console.error("Błąd powiadomienia:", error);
    }
}

function addSystemComment(ticket, text, clientPrincipal) {
    if (!ticket.comments) ticket.comments = [];
    ticket.comments.push({
        author: `System (${clientPrincipal.userDetails})`,
        text: text,
        timestamp: new Date().toISOString(),
        isSystemComment: true
    });
}

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: { message: "Brak uwierzytelnienia." } };
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    if (!clientPrincipal.userRoles.includes('sd')) {
        return { status: 403, body: { message: "Brak uprawnień." } };
    }

    // --- NOWOŚĆ: Pobieramy ETAG ---
    const { ticketId, changes, etag } = req.body;
    
    if (!ticketId || !changes) {
        return { status: 400, body: { message: "Brak wymaganych danych." } };
    }

    // --- NOWOŚĆ: Walidacja ETAG ---
    if (!etag) {
        return { status: 428, body: { message: "Błąd spójności: Brak nagłówka ETag (odśwież stronę)." } };
    }

    try {
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
        };
        const { resources: items } = await ticketsContainer.items.query(querySpec).fetchAll();
        if (items.length === 0) return { status: 404, body: { message: "Nie znaleziono zgłoszenia." } };
        
        let ticket = items[0];
        const originalCategory = ticket.category;
        const reportingUserEmail = ticket.reportingUser.email;
        const isSelfUpdate = reportingUserEmail.toLowerCase() === clientPrincipal.userDetails.toLowerCase();

        // --- Logika Biznesowa ---

        if (ticket.status === 'Zamknięte') {
            const isReopening = changes.status && changes.status === 'Otwarte';
            if (isReopening) {
                 addSystemComment(ticket, `Zmieniono status z "Zamknięte" na "Otwarte".`, clientPrincipal);
                 ticket.status = 'Otwarte';
                 ticket.dates.closedAt = null;
                 if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} otwarte ponownie.`, ticketId);
            } else {
                return { status: 403, body: { message: "Błąd: Zgłoszenie jest zamknięte." } };
            }
        } else {
            if (changes.status && ticket.status !== changes.status) {
                if (['Rozwiązane', 'Odrzucone'].includes(changes.status)) {
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "Zamknięte".`, clientPrincipal);
                    ticket.status = 'Zamknięte'; 
                    ticket.dates.closedAt = new Date().toISOString();
                    if (!ticket.assignedTo.person) ticket.assignedTo.person = clientPrincipal.userDetails;

                    try {
                        const { resources: sData } = await ticketsContainer.items.query("SELECT * FROM c WHERE c.id = 'global_settings'").fetchAll();
                        if (sData.length > 0 && sData[0].groups) {
                            const closingEmail = clientPrincipal.userDetails.toLowerCase();
                            const userGroup = sData[0].groups.find(g => g.members && g.members.includes(closingEmail));
                            if (userGroup && ticket.assignedTo.group !== userGroup.name) {
                                addSystemComment(ticket, `Automatycznie zmieniono grupę na "${userGroup.name}".`, clientPrincipal);
                                ticket.assignedTo.group = userGroup.name;
                            }
                        }
                    } catch (e) {}

                    if (changes.closingComment) addSystemComment(ticket, `Komentarz zamknięcia: ${changes.closingComment}`, clientPrincipal);
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} zamknięte (${changes.status}).`, ticketId);

                } else { 
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "${changes.status}".`, clientPrincipal);
                    ticket.status = changes.status;
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId}: nowy status "${changes.status}".`, ticketId);
                }
            }

            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;
                if (ticket.status === 'Nieprzeczytane') {
                    ticket.status = 'Otwarte';
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} przyjęte do realizacji.`, ticketId);
                }
            }

            if (changes.category && ticket.category !== changes.category) {
                const { resources: sData } = await ticketsContainer.items.query("SELECT * FROM c WHERE c.id = 'global_settings'").fetchAll();
                const globalSettings = sData.length > 0 ? sData[0] : null;

                let newGroup = "Pierwsza linia wsparcia";
                let newSlaHours = 8;
                let workConfig = { startHour: 8, endHour: 16, holidays: [] };

                if (globalSettings) {
                    const catConfig = globalSettings.categories.find(c => c.name === changes.category);
                    if (catConfig) {
                        newGroup = catConfig.assignedGroup;
                        newSlaHours = catConfig.sla;
                    }
                    if (globalSettings.workConfig) workConfig = globalSettings.workConfig;
                }

                addSystemComment(ticket, `Zmieniono kategorię z "${ticket.category}" na "${changes.category}".`, clientPrincipal);
                ticket.category = changes.category;
                
                if (newGroup !== ticket.assignedTo.group) {
                    addSystemComment(ticket, `Zmieniono grupę na: ${newGroup}.`, clientPrincipal);
                    ticket.assignedTo.group = newGroup;
                    if(ticket.assignedTo.person) ticket.assignedTo.person = null;
                }

                const newSlaDate = calculateAdvancedSLA(ticket.dates.createdAt, newSlaHours, workConfig);
                ticket.dates.guaranteedResolutionAt = newSlaDate.toISOString();
                addSystemComment(ticket, `Zaktualizowano termin SLA (${newSlaHours}h).`, clientPrincipal);

                if (ticket.status === 'Nieprzeczytane') ticket.status = 'Otwarte';
            }

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
        
        // --- SEKCJA ZAPISU Z BLOKADĄ (OPTIMISTIC CONCURRENCY) ---
        
        // Sytuacja 1: Zmiana kategorii (zmiana Partition Key)
        if (ticket.category !== originalCategory) {
            try {
                // Usuń stary TYLKO jeśli ETag się zgadza
                await ticketsContainer.item(ticketId, originalCategory).delete({ ifMatch: etag });
                
                // Utwórz nowy
                const { resource: createdItem } = await ticketsContainer.items.create(ticket);
                context.res = { body: createdItem };

            } catch (deleteErr) {
                if (deleteErr.code === 412) {
                    context.res = { status: 412, body: { message: "Konflikt edycji: Ktoś inny zmodyfikował to zgłoszenie." } };
                } else {
                    throw deleteErr;
                }
            }
        } else {
            // Sytuacja 2: Standardowa aktualizacja
            try {
                // Używamy replace + ifMatch zamiast upsert
                const { resource: updatedItem } = await ticketsContainer
                    .item(ticketId, ticket.category)
                    .replace(ticket, { ifMatch: etag });

                context.res = { body: updatedItem };

            } catch (updateErr) {
                if (updateErr.code === 412) {
                    context.res = { status: 412, body: { message: "Konflikt edycji: Ktoś inny zmodyfikował to zgłoszenie." } };
                } else {
                    throw updateErr;
                }
            }
        }

    } catch (error) {
        context.log.error("Error updateTicket:", error);
        context.res = { status: 500, body: { message: "Wystąpił błąd serwera." } };
    }
};