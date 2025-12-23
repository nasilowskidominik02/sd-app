const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    // Funkcja pomocnicza do wysyłania odpowiedzi (żeby uniknąć pustych body)
    const sendResponse = (status, body) => {
        context.res = {
            status: status,
            headers: { "Content-Type": "application/json" },
            body: body
        };
        context.done(); // Jawnie kończymy funkcję
    };

    try {
        // --- 1. AUTORYZACJA ---
        const header = req.headers['x-ms-client-principal'];
        if (!header) {
            sendResponse(401, { message: "Brak autoryzacji (Missing Header)" });
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
            sendResponse(400, { message: "Brak ID zgłoszenia lub zmian." });
            return;
        }

        // --- 3. POBRANIE ZGŁOSZENIA ---
        // Używamy bezpieczniejszego zapytania zamiast point-read, jeśli nie jesteśmy pewni PartitionKey
        // Zakładamy jednak, że ticketId to też PartitionKey. Jeśli nie - to może być źródło problemu.
        // Dla pewności spróbujmy pobrać item.
        let ticket = null;
        try {
            const response = await container.item(ticketId, ticketId).read();
            ticket = response.resource;
        } catch (e) {
            // Ignorujemy błąd, obsłużymy brak ticketa niżej
        }

        if (!ticket) {
            sendResponse(404, { message: "Nie znaleziono zgłoszenia (ID nie istnieje)." });
            return;
        }

        // Kopia do edycji
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
                const { resources: settings } = await container.items.query(
                    "SELECT * FROM c WHERE c.id = 'global_settings'",
                    { enableCrossPartitionQuery: true }
                ).fetchAll();

                if (settings && settings.length > 0) {
                    const config = settings[0];
                    const catConfig = config.categories ? config.categories.find(c => c.name === changes.category) : null;
                    
                    if (catConfig) {
                        const newPriority = catConfig.priority;
                        const prioConfig = config.priorities ? config.priorities.find(p => p.name === newPriority) : null;
                        
                        if (prioConfig) {
                            const hours = parseInt(prioConfig.resolutionTime);
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
                context.log.error("Błąd przeliczania SLA:", e);
                // Nie przerywamy działania, po prostu SLA się nie zaktualizuje
            }
        }

        // C. Przypisanie
        if (changes.assignedTo) {
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

        // Wysyłanie powiadomień (w bloku try-catch, żeby błąd powiadomienia nie wywalił całej funkcji)
        if (notificationsToSend.length > 0) {
            for (const notif of notificationsToSend) {
                try {
                    const notifDoc = {
                        id: Math.random().toString(36).substring(2, 15),
                        // WAŻNE: Dodajemy ticketId jako pseudo-klucz partycji lub inne pole,
                        // jeśli Twoja baza wymaga konkretnego PartitionKey dla wszystkich dokumentów.
                        // Jeśli PK to /id, to jest ok. Jeśli PK to /category, powiadomienie musi je mieć!
                        // Dla bezpieczeństwa dodajemy kategorię ze zgłoszenia do powiadomienia (jeśli PK to kategoria)
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
                    context.log.error("Błąd tworzenia powiadomienia (niekrytyczny):", err.message);
                }
            }
        }

        // --- 7. FINISH ---
        sendResponse(200, savedTicket);

    } catch (error) {
        context.log.error("CRITICAL UPDATE ERROR:", error);
        sendResponse(500, { 
            message: "Internal Server Error", 
            details: error.message 
        });
    }
};