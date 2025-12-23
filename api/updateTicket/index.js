const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    try {
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
        };

    } catch (error) {
        context.log.error("CRITICAL UPDATE ERROR:", error);
        context.res = {
            status: 500,
            headers: { "Content-Type": "application/json" },
            body: { 
                message: "Internal Server Error", 
                details: error.message 
            }
        };
    }
    // WAŻNE: W funkcji async NIE wywołujemy context.done()!
};