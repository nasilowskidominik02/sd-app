const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const ticketsContainer = database.container("Tickets");

// --- FUNKCJE POMOCNICZE ---

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

// --- GŁÓWNA FUNKCJA ---

module.exports = async function (context, req) {
    // 1. Uwierzytelnienie
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        context.res = { status: 401, body: { message: "Brak uwierzytelnienia." } };
        return;
    }
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    if (!clientPrincipal.userRoles.includes('sd')) {
        context.res = { status: 403, body: { message: "Brak uprawnień." } };
        return;
    }

    const { ticketId, changes, etag } = req.body;
    
    // 2. Walidacja danych
    if (!ticketId || !changes) {
        context.res = { status: 400, body: { message: "Brak wymaganych danych." } };
        return;
    }

    if (!etag) {
        context.res = { status: 428, body: { message: "Błąd spójności: Brak nagłówka ETag. Odśwież stronę." } };
        return;
    }

    try {
        // 3. Pobranie zgłoszenia
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
        };
        const { resources: items } = await ticketsContainer.items.query(querySpec).fetchAll();
        
        if (items.length === 0) {
            context.res = { status: 404, body: { message: "Nie znaleziono zgłoszenia." } };
            return;
        }
        
        let ticket = items[0];

        // --- 4. MANUALNA WERYFIKACJA ETAG (POPRAWIONA) ---
        // Używamy context.res zamiast return { ... }
        if (ticket._etag !== etag) {
            context.log(`[CONFLICT] DB Etag: ${ticket._etag} vs Req Etag: ${etag}`);
            context.res = { 
                status: 412, 
                body: { message: "Konflikt edycji: Ktoś inny zmodyfikował to zgłoszenie w międzyczasie." } 
            };
            return; // WAŻNE: Kończymy działanie funkcji
        }
        // ------------------------------------------------

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
                context.res = { status: 403, body: { message: "Błąd: Zgłoszenie jest zamknięte." } };
                return;
            }
        } else {
            // Zmiany statusów
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

            // Zmiany przypisania
            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;
                if (ticket.status === 'Nieprzeczytane') {
                    ticket.status = 'Otwarte';
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} przyjęte do realizacji.`, ticketId);
                }
            }

            // Zmiana kategorii
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

            // Nowy komentarz
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
        
        // --- 5. CZYSZCZENIE I ZAPIS ---
        delete ticket._rid;
        delete ticket._self;
        delete ticket._etag; 
        delete ticket._attachments;
        delete ticket._ts;

        if (changes.category && changes.category !== originalCategory) {
            try {
                await ticketsContainer.item(ticketId, originalCategory).delete({ ifMatch: etag });
                const { resource: createdItem } = await ticketsContainer.items.create(ticket);
                context.res = { body: createdItem };
            } catch (err) {
                if (err.code === 412) {
                    context.res = { status: 412, body: { message: "Konflikt edycji (zmiana kategorii)." } };
                } else throw err;
            }
        } else {
            try {
                const { resource: updatedItem } = await ticketsContainer
                    .item(ticketId, ticket.category)
                    .replace(ticket, { ifMatch: etag });

                context.res = { body: updatedItem };
            } catch (err) {
                if (err.code === 412) {
                    context.res = { status: 412, body: { message: "Konflikt edycji." } };
                } else throw err;
            }
        }

    } catch (error) {
        context.log.error("Error updateTicket:", error);
        context.res = { status: 500, body: { message: "Wystąpił błąd serwera." } };
    }
};