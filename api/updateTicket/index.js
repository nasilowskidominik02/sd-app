const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");
// Zakładamy, że powiadomienia mogą być w tym samym kontenerze (typ 'notification') lub innym.
// Tu przyjmuję bezpieczną strategię zapisu do głównego kontenera.

module.exports = async function (context, req) {
    try {
        // --- 1. AUTORYZACJA ---
        const header = req.headers['x-ms-client-principal'];
        if (!header) return { status: 401, body: "Brak autoryzacji" };
        
        const encoded = Buffer.from(header, 'base64');
        const decoded = encoded.toString('ascii');
        const clientPrincipal = JSON.parse(decoded);
        
        const userEmail = clientPrincipal.userDetails;
        const isSD = clientPrincipal.userRoles.includes('sd');

        // --- 2. WALIDACJA ---
        const { ticketId, changes } = req.body;
        if (!ticketId || !changes) {
            return { status: 400, body: "Brak ID zgłoszenia lub zmian." };
        }

        // --- 3. POBRANIE ZGŁOSZENIA ---
        const { resource: ticket } = await container.item(ticketId, ticketId).read();
        if (!ticket) {
            return { status: 404, body: "Nie znaleziono zgłoszenia." };
        }

        // Kopia do edycji
        let updatedTicket = { ...ticket };
        let notificationsToSend = []; // Kolejka powiadomień do utworzenia

        // --- 4. OBSŁUGA ZMIAN (CORE) ---

        // A. Zmiana Statusu
        if (changes.status) {
            updatedTicket.status = changes.status;
            
            // Jeśli zamykamy
            if (['Rozwiązane', 'Odrzucone', 'Zamknięte'].includes(changes.status)) {
                updatedTicket.dates.closedAt = new Date().toISOString();
                
                // Jeśli jest komentarz zamykający
                if (changes.closingComment) {
                    updatedTicket.comments.push({
                        author: userEmail,
                        text: `[ZAMKNIĘCIE] ${changes.closingComment}`,
                        timestamp: new Date().toISOString(),
                        isSystemComment: true
                    });
                }
            } else {
                // Jeśli otwieramy ponownie, czyścimy datę zamknięcia
                updatedTicket.dates.closedAt = null;
            }

            // Powiadomienie dla użytkownika o zmianie statusu
            if (isSD && ticket.reportingUser.email !== userEmail) {
                notificationsToSend.push({
                    recipient: ticket.reportingUser.email,
                    message: `Status zgłoszenia #${ticket.id} zmienił się na: ${changes.status}`,
                    ticketId: ticket.id
                });
            }
        }

        // B. Zmiana Kategorii (TUTAJ JEST FIX SLA)
        if (changes.category && changes.category !== ticket.category) {
            updatedTicket.category = changes.category;
            
            try {
                // Pobieramy ustawienia, żeby znaleźć priorytet nowej kategorii
                const { resources: settings } = await container.items.query(
                    "SELECT * FROM c WHERE c.id = 'global_settings'",
                    { enableCrossPartitionQuery: true }
                ).fetchAll();

                if (settings && settings.length > 0) {
                    const config = settings[0];
                    const catConfig = config.categories.find(c => c.name === changes.category);
                    
                    if (catConfig) {
                        const newPriority = catConfig.priority; // np. "Wysoki"
                        const prioConfig = config.priorities.find(p => p.name === newPriority);
                        
                        if (prioConfig) {
                            const hours = parseInt(prioConfig.resolutionTime);
                            // Liczymy od daty UTWORZENIA, nie od teraz
                            const createdAt = new Date(ticket.dates.createdAt);
                            const newSla = new Date(createdAt.getTime() + (hours * 60 * 60 * 1000));
                            
                            updatedTicket.dates.guaranteedResolutionAt = newSla.toISOString();
                            
                            // Log w komentarzach
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
            }
        }

        // C. Przypisanie (Assigned To)
        if (changes.assignedTo) {
            // Logika: scalanie obiektu, żeby nie stracić grupy jeśli zmieniamy osobę
            updatedTicket.assignedTo = { ...ticket.assignedTo, ...changes.assignedTo };
            
            // Powiadomienie dla osoby przypisanej
            if (changes.assignedTo.person && changes.assignedTo.person !== userEmail) {
                notificationsToSend.push({
                    recipient: changes.assignedTo.person, // Zakładamy że to email
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

            // Logika powiadomień o komentarzu
            if (isSD) {
                // Jeśli pisze SD, powiadom użytkownika
                if (ticket.reportingUser.email !== userEmail) {
                    notificationsToSend.push({
                        recipient: ticket.reportingUser.email,
                        message: `Nowy komentarz w zgłoszeniu #${ticket.id}`,
                        ticketId: ticket.id
                    });
                }
            } else {
                // Jeśli pisze User, powiadom przypisanego serwisanta
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

        // --- 6. ZAPIS DO BAZY (Transakcja: Bilet + Powiadomienia) ---
        
        // Zapisujemy zaktualizowane zgłoszenie
        const { resource: savedTicket } = await container.item(ticketId, ticketId).replace(updatedTicket);

        // Wysyłamy powiadomienia (tworzymy nowe dokumenty w bazie)
        if (notificationsToSend.length > 0) {
            const notificationsOperations = notificationsToSend.map(n => {
                return {
                    id:  Math.random().toString(36).substring(2, 15), // proste ID
                    type: "notification", // Ważne dla filtrowania
                    recipient: n.recipient, // Email odbiorcy
                    message: n.message,
                    ticketId: n.ticketId,
                    isRead: false,
                    createdAt: new Date().toISOString(),
                    ttl: 60 * 60 * 24 * 7 // Opcjonalnie: auto-usuwanie po 7 dniach
                };
            });

            // Zapisujemy powiadomienia jedno po drugim (można użyć Bulk, ale loop jest bezpieczniejszy przy małej skali)
            for (const notif of notificationsOperations) {
                try {
                    await container.items.create(notif);
                } catch (err) {
                    context.log.error("Błąd tworzenia powiadomienia:", err);
                }
            }
        }

        // --- 7. FINISH ---
        context.res = {
            status: 200,
            body: savedTicket
        };

    } catch (error) {
        context.log.error("CRITICAL UPDATE ERROR:", error);
        context.res = {
            status: 500,
            body: { message: "Internal Server Error", details: error.message }
        };
    }
};