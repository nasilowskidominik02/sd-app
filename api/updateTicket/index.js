const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
<<<<<<< HEAD
const container = client.database("ServiceDeskDB").container("Tickets");
=======
const database = client.database("ServiceDeskDB");
const ticketsContainer = database.container("Tickets");

// Funkcja zapisuje powiadomienie
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
>>>>>>> parent of 219ee38 (Update index.js)

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
<<<<<<< HEAD
        // --- 1. AUTORYZACJA ---
        const header = req.headers['x-ms-client-principal'];
        if (!header) {
            context.res = { status: 401, body: { message: "Brak autoryzacji" } };
            return;
        }
        
        const encoded = Buffer.from(header, 'base64');
        const decoded = encoded.toString('ascii');
        const clientPrincipal = JSON.parse(decoded);
        
        const userEmail = clientPrincipal.userDetails;
        const isSD = clientPrincipal.userRoles.includes('sd');

        // --- 2. WALIDACJA ---
        const { ticketId, changes } = req.body;
        if (!ticketId || !changes) {
            context.res = { status: 400, body: { message: "Brak ID zgłoszenia lub zmian." } };
            return;
        }

        // --- 3. POBRANIE ZGŁOSZENIA ---
        // Najpierw próbujemy pobrać zgłoszenie, żeby sprawdzić czy istnieje
        let ticket = null;
        try {
            // Zakładamy, że PartitionKey to ticketId (najczęstsza konfiguracja). 
            // Jeśli Twoja baza ma inny PartitionKey (np. /category), tu może być potrzebne query.
            const response = await container.item(ticketId, ticketId).read();
            ticket = response.resource;
        } catch (e) {
            // Ignorujemy błąd 404 z bazy, obsłużymy go if-em niżej
        }

        if (!ticket) {
            context.res = { status: 404, body: { message: "Nie znaleziono zgłoszenia." } };
            return;
        }

        let updatedTicket = { ...ticket };
        let notificationsToSend = []; 

        // --- 4. OBSŁUGA ZMIAN ---

        // A. Zmiana Statusu
        if (changes.status) {
            updatedTicket.status = changes.status;
            
            if (['Rozwiązane', 'Odrzucone', 'Zamknięte'].includes(changes.status)) {
                updatedTicket.dates.closedAt = new Date().toISOString();
                if (changes.closingComment) {
                    updatedTicket.comments.push({
                        author: userEmail,
                        text: `[ZAMKNIĘCIE] ${changes.closingComment}`,
                        timestamp: new Date().toISOString(),
                        isSystemComment: true
                    });
                }
            } else {
                updatedTicket.dates.closedAt = null;
            }

            // Powiadomienie dla usera
            if (isSD && ticket.reportingUser.email !== userEmail) {
                notificationsToSend.push({
                    recipient: ticket.reportingUser.email,
                    message: `Status zgłoszenia #${ticket.id} zmienił się na: ${changes.status}`,
                    ticketId: ticket.id
                });
            }
        }

        // B. Zmiana Kategorii (FIX SLA)
        if (changes.category && changes.category !== ticket.category) {
            updatedTicket.category = changes.category;
            
            try {
                // Pobieramy ustawienia
                const { resources: settings } = await container.items.query(
                    "SELECT * FROM c WHERE c.id = 'global_settings'",
                    { enableCrossPartitionQuery: true }
                ).fetchAll();

                if (settings && settings.length > 0) {
                    const config = settings[0];
                    // Bezpieczne sprawdzanie czy categories istnieje
                    const catConfig = config.categories ? config.categories.find(c => c.name === changes.category) : null;
                    
                    if (catConfig) {
                        const newPriority = catConfig.priority;
                        const prioConfig = config.priorities ? config.priorities.find(p => p.name === newPriority) : null;
                        
                        if (prioConfig) {
                            const hours = parseInt(prioConfig.resolutionTime);
                            // Liczymy SLA od daty UTWORZENIA
                            const createdAt = new Date(ticket.dates.createdAt);
                            const newSla = new Date(createdAt.getTime() + (hours * 60 * 60 * 1000));
                            
                            updatedTicket.dates.guaranteedResolutionAt = newSla.toISOString();
                            
                            updatedTicket.comments.push({
                                author: "System",
                                text: `Zmiana kategorii na "${changes.category}". Nowy termin SLA: ${newSla.toLocaleString('pl-PL')}`,
                                timestamp: new Date().toISOString(),
                                isSystemComment: true
                            });
                        }
                    }
                }
            } catch (e) {
                context.log.error("Błąd przeliczania SLA (niekrytyczny):", e.message);
            }
        }

        // C. Przypisanie
        if (changes.assignedTo) {
            // Zachowujemy stare dane i nadpisujemy nowymi
            updatedTicket.assignedTo = { ...ticket.assignedTo, ...changes.assignedTo };
            
            if (changes.assignedTo.person && changes.assignedTo.person !== userEmail) {
                notificationsToSend.push({
                    recipient: changes.assignedTo.person,
                    message: `Zostałeś przypisany do zgłoszenia #${ticket.id}`,
                    ticketId: ticket.id
                });
            }
        }

        // D. Nowy Komentarz
        if (changes.newComment) {
            const newComm = {
                author: userEmail,
                text: changes.newComment.text,
                timestamp: new Date().toISOString(),
                isSystemComment: changes.newComment.isSystemComment || false,
                attachment: changes.newComment.attachment || null
            };
            
            if (!updatedTicket.comments) updatedTicket.comments = [];
            updatedTicket.comments.push(newComm);

            if (isSD) {
                if (ticket.reportingUser.email !== userEmail) {
                    notificationsToSend.push({
                        recipient: ticket.reportingUser.email,
                        message: `Nowy komentarz w zgłoszeniu #${ticket.id}`,
                        ticketId: ticket.id
                    });
                }
            } else {
                if (ticket.assignedTo && ticket.assignedTo.person) {
                    notificationsToSend.push({
                        recipient: ticket.assignedTo.person,
                        message: `Użytkownik dodał komentarz do zgłoszenia #${ticket.id}`,
                        ticketId: ticket.id
                    });
                }
            }
        }

        // --- 5. AKTUALIZACJA METADANYCH ---
        updatedTicket.dates.updatedAt = new Date().toISOString();

        // --- 6. ZAPIS DO BAZY ---
        const { resource: savedTicket } = await container.item(ticketId, ticketId).replace(updatedTicket);

        // --- 7. POWIADOMIENIA ---
        if (notificationsToSend.length > 0) {
            for (const notif of notificationsToSend) {
                try {
                    const notifDoc = {
                        id: Math.random().toString(36).substring(2, 15),
                        // Dodajemy kategorię, bo jeśli baza jest partycjonowana po kategorii, to jest wymagane
                        category: updatedTicket.category || "General", 
                        type: "notification",
                        recipient: notif.recipient,
                        message: notif.message,
                        ticketId: notif.ticketId,
                        isRead: false,
                        createdAt: new Date().toISOString()
                    };
                    await container.items.create(notifDoc);
                } catch (err) {
                    context.log.error("Błąd zapisu powiadomienia:", err.message);
                }
            }
        }

        // --- 8. SUKCES ---
        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: savedTicket
=======
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @ticketId",
            parameters: [{ name: "@ticketId", value: ticketId }]
>>>>>>> parent of 219ee38 (Update index.js)
        };
        
        const { resources: items } = await ticketsContainer.items.query(querySpec).fetchAll();
        if (items.length === 0) return { status: 404, body: { message: "Ticket not found." } };
        
        let ticket = items[0];
        const originalCategory = ticket.category;
        const reportingUserEmail = ticket.reportingUser.email;
        const isSelfUpdate = reportingUserEmail.toLowerCase() === clientPrincipal.userDetails.toLowerCase();

        // 1. Logika ZAMKNIĘCIA (Ticket był już zamknięty i ktoś próbuje go edytować)
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
            // 2. ZMIANA STATUSU (Ticket jest otwarty)
            if (changes.status && ticket.status !== changes.status) {
                
                // --- SCENARIUSZ: ZAMYKANIE ZGŁOSZENIA ---
                if (['Rozwiązane', 'Odrzucone'].includes(changes.status)) {
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "Zamknięte".`, clientPrincipal);
                    ticket.status = 'Zamknięte'; 
                    ticket.dates.closedAt = new Date().toISOString();
                    
                    // Przypisz osobę zamykającą, jeśli nikt nie był przypisany
                    if (!ticket.assignedTo.person) {
                        ticket.assignedTo.person = clientPrincipal.userDetails;
                    }

                    // --- NOWOŚĆ: Automatyczna zmiana Grupy na grupę osoby zamykającej ---
                    try {
                        // Pobieramy ustawienia globalne, żeby sprawdzić członków grup
                        const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
                        const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
                        const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;

                        if (globalSettings && globalSettings.groups) {
                            const closingUserEmail = clientPrincipal.userDetails.toLowerCase();
                            
                            // Szukamy grupy, która zawiera maila osoby zamykającej
                            const userGroup = globalSettings.groups.find(g => 
                                g.members && g.members.includes(closingUserEmail)
                            );

                            // Jeśli znaleziono grupę i jest inna niż obecna -> podmieniamy
                            if (userGroup && ticket.assignedTo.group !== userGroup.name) {
                                addSystemComment(ticket, `Automatycznie zmieniono grupę na "${userGroup.name}" (zgodnie z zespołem osoby zamykającej).`, clientPrincipal);
                                ticket.assignedTo.group = userGroup.name;
                            }
                        }
                    } catch (grpErr) {
                        context.log.error("Błąd przy automatycznej zmianie grupy:", grpErr);
                        // Nie przerywamy działania, to tylko funkcja pomocnicza
                    }
                    // -------------------------------------------------------------------

                    if (changes.closingComment) {
                         addSystemComment(ticket, `Dodano komentarz zamknięcia: ${changes.closingComment}`, clientPrincipal);
                    }
                    
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} zostało zamknięte (${changes.status}).`, ticketId);

                } else { 
                    // --- SCENARIUSZ: INNA ZMIANA STATUSU (np. W toku) ---
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "${changes.status}".`, clientPrincipal);
                    ticket.status = changes.status;
                    
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId}: nowy status "${changes.status}".`, ticketId);
                }
            }

            // 3. PRZYPISANIE
            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano zgłoszenie do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;

                if (ticket.status === 'Nieprzeczytane') {
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                    
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} przyjęte do realizacji.`, ticketId);
                }
            }

            // 4. ZMIANA KATEGORII
            if (changes.category && ticket.category !== changes.category) {
                // Pobieramy ustawienia, żeby znaleźć domyślną grupę dla nowej kategorii
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
                
                // Jeśli zmiana kategorii wymusza zmianę grupy
                if (newGroup !== ticket.assignedTo.group) {
                    addSystemComment(ticket, `Zmieniono grupę odpowiedzialną na: ${newGroup}.`, clientPrincipal);
                    ticket.assignedTo.group = newGroup;
                    // Resetujemy osobę przypisaną, bo trafiło do nowej grupy
                    if(ticket.assignedTo.person) ticket.assignedTo.person = null;
                }

                if (ticket.status === 'Nieprzeczytane') { 
                    addSystemComment(ticket, `Automatycznie zmieniono status z "Nieprzeczytane" na "Otwarte".`, clientPrincipal);
                    ticket.status = 'Otwarte';
                    
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} zakwalifikowane.`, ticketId);
                }
            }

            // 5. KOMENTARZ
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
        
        // Zapis do bazy (upsert lub delete+create przy zmianie partycji)
        if (ticket.category !== originalCategory) {
            const { resource: createdItem } = await ticketsContainer.items.create(ticket);
            await ticketsContainer.item(ticketId, originalCategory).delete();
            context.res = { body: createdItem };
        } else {
            const { resource: updatedItem } = await ticketsContainer.items.upsert(ticket);
            context.res = { body: updatedItem };
        }

    } catch (error) {
<<<<<<< HEAD
        context.log.error("CRITICAL UPDATE ERROR:", error);
        context.res = {
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: { 
                message: "Internal Server Error", 
                details: error.message 
            }
        };
=======
        context.log.error("Error in updateTicket:", error.stack);
        context.res = { status: 500, body: { message: "Error updating ticket." } };
>>>>>>> parent of 219ee38 (Update index.js)
    }
    // WAŻNE: W funkcji async NIE wywołujemy context.done()!
};