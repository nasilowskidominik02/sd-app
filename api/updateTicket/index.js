const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const ticketsContainer = database.container("Tickets");

// --- FUNKCJE POMOCNICZE ---

/**
 * Oblicza nowy termin realizacji (SLA) na podstawie kalendarza pracy.
 * * Funkcja jest używana przy zmianie kategorii zgłoszenia, co wiąże się ze zmianą SLA.
 * Algorytm dynamicznie przesuwa termin, pomijając dni wolne i godziny nocne,
 * zapewniając sprawiedliwy czas na reakcję dla zespołu wsparcia.
 *
 * @param {Date|string} startDate - Data od której liczymy czas (data utworzenia zgłoszenia).
 * @param {number} hoursToAdd - Ilość godzin roboczych do dodania.
 * @param {Object} workConfig - Konfiguracja czasu pracy (godziny start/stop, święta).
 * @returns {Date} Nowa data graniczna SLA.
 */
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

/**
 * Tworzy asynchroniczne powiadomienie dla użytkownika w systemie.
 * Powiadomienia są przechowywane jako oddzielne dokumenty w kontenerze 'Tickets'
 * z typem 'notification', co pozwala na ich łatwe pobieranie per użytkownik.
 *
 * @param {string} recipientEmail - Adres e-mail odbiorcy.
 * @param {string} message - Treść powiadomienia.
 * @param {string} ticketId - ID zgłoszenia, którego dotyczy powiadomienie.
 */
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

/**
 * Dodaje wpis do historii (audytu) zgłoszenia.
 * Komentarze systemowe są kluczowe dla śledzenia cyklu życia zgłoszenia 
 * (zmiany statusów, przypisań) i nie mogą być edytowane przez użytkowników.
 *
 * @param {Object} ticket - Obiekt zgłoszenia modyfikowany przez referencję.
 * @param {string} text - Treść logu systemowego.
 * @param {Object} clientPrincipal - Dane użytkownika wykonującego akcję.
 */
function addSystemComment(ticket, text, clientPrincipal) {
    if (!ticket.comments) ticket.comments = [];
    ticket.comments.push({
        author: `System (${clientPrincipal.userDetails})`,
        text: text,
        timestamp: new Date().toISOString(),
        isSystemComment: true
    });
}

/**
 * Główna funkcja aktualizująca zgłoszenie.
 * * Jest to najbardziej złożona funkcja w systemie, obsługująca:
 * 1. Walidację spójności danych przy użyciu mechanizmu ETag (Optimistic Concurrency Control).
 * 2. Logikę biznesową zmian stanów (Status, Przypisanie, Kategoria).
 * 3. Skomplikowane operacje bazodanowe:
 * - Standardowy UPDATE (replace) dla zmian w obrębie tej samej partycji.
 * - Transakcję DELETE + CREATE dla zmiany kategorii (zmiana Partition Key).
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure.
 * @param {Object} req - Obiekt żądania HTTP.
 * @param {string} req.body.ticketId - ID edytowanego zgłoszenia.
 * @param {Object} req.body.changes - Obiekt zawierający tylko zmienione pola.
 * @param {string} req.body.etag - Wersja dokumentu posiadana przez klienta (niezbędna do zapisu).
 * @returns {Object} Odpowiedź HTTP (200 OK z nowym obiektem lub kod błędu).
 */
module.exports = async function (context, req) {
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
    
    if (!ticketId || !changes) {
        context.res = { status: 400, body: { message: "Brak wymaganych danych." } };
        return;
    }

    // Wymuszenie obecności ETag chroni przed przypadkowym nadpisaniem danych
    // przez klienta, który nie obsługuje mechanizmu współbieżności.
    if (!etag) {
        context.res = { status: 428, body: { message: "Błąd spójności: Brak nagłówka ETag. Odśwież stronę." } };
        return;
    }

    try {
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

        // MANUALNA WERYFIKACJA ETAG (Hard Check)
        // Mimo że Cosmos DB obsługuje 'ifMatch' w metodzie replace,
        // wykonujemy ręczne sprawdzenie tutaj, aby natychmiast przerwać przetwarzanie
        // i zwrócić precyzyjny komunikat błędu, zanim wykonamy jakąkolwiek logikę biznesową.
        // Zapobiega to sytuacji "Lost Update" (nadpisania zmian innego agenta).
        if (ticket._etag !== etag) {
            context.log(`[CONFLICT] DB Etag: ${ticket._etag} vs Req Etag: ${etag}`);
            context.res = { 
                status: 412, 
                body: { message: "Konflikt edycji: Ktoś inny zmodyfikował to zgłoszenie w międzyczasie." } 
            };
            return; 
        }

        const originalCategory = ticket.category;
        const reportingUserEmail = ticket.reportingUser.email;
        const isSelfUpdate = reportingUserEmail.toLowerCase() === clientPrincipal.userDetails.toLowerCase();

        // --- APLIKOWANIE LOGIKI BIZNESOWEJ ---

        if (ticket.status === 'Zamknięte') {
            // Zgłoszenia zamknięte są "zamrożone" - jedyna dozwolona akcja to ponowne otwarcie.
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
            // Obsługa zmian statusu
            if (changes.status && ticket.status !== changes.status) {
                if (['Rozwiązane', 'Odrzucone'].includes(changes.status)) {
                    addSystemComment(ticket, `Zmieniono status z "${ticket.status}" na "Zamknięte".`, clientPrincipal);
                    ticket.status = 'Zamknięte'; 
                    ticket.dates.closedAt = new Date().toISOString();
                    
                    // Automatyczne przypisanie zamykającego, jeśli zgłoszenie wisiało na nikim
                    if (!ticket.assignedTo.person) ticket.assignedTo.person = clientPrincipal.userDetails;

                    // Automatyczna korekta grupy przypisania (jeśli zamykający jest z innej grupy)
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

            // Obsługa zmian przypisania (Agent)
            if (changes.assignedTo && changes.assignedTo.person && ticket.assignedTo.person !== changes.assignedTo.person) {
                addSystemComment(ticket, `Przypisano do: ${changes.assignedTo.person}.`, clientPrincipal);
                ticket.assignedTo.person = changes.assignedTo.person;
                // Jeśli zgłoszenie było nowe, automatycznie zmieniamy status na "w toku" (Otwarte)
                if (ticket.status === 'Nieprzeczytane') {
                    ticket.status = 'Otwarte';
                    if (!isSelfUpdate) await sendNotification(reportingUserEmail, `Zgłoszenie #${ticketId} przyjęte do realizacji.`, ticketId);
                }
            }

            // Obsługa zmiany kategorii
            // Zmiana kategorii jest krytyczna, ponieważ wpływa na Partition Key (category) oraz SLA.
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
                
                // Zmiana grupy przypisania, jeśli nowa kategoria tego wymaga
                if (newGroup !== ticket.assignedTo.group) {
                    addSystemComment(ticket, `Zmieniono grupę na: ${newGroup}.`, clientPrincipal);
                    ticket.assignedTo.group = newGroup;
                    // Resetujemy przypisanie do osoby, bo może nie należeć do nowej grupy
                    if(ticket.assignedTo.person) ticket.assignedTo.person = null;
                }

                // Przeliczenie SLA wg nowej konfiguracji
                const newSlaDate = calculateAdvancedSLA(ticket.dates.createdAt, newSlaHours, workConfig);
                ticket.dates.guaranteedResolutionAt = newSlaDate.toISOString();
                addSystemComment(ticket, `Zaktualizowano termin SLA (${newSlaHours}h).`, clientPrincipal);

                if (ticket.status === 'Nieprzeczytane') ticket.status = 'Otwarte';
            }

            // Dodawanie nowego komentarza użytkownika
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
        
        // --- PRZYGOTOWANIE DO ZAPISU ---
        // Usuwamy pola systemowe generowane przez Cosmos DB (_rid, _self, etc.),
        // ponieważ przy funkcji replace/create nie mogą one być częścią payloadu.
        delete ticket._rid;
        delete ticket._self;
        delete ticket._etag; 
        delete ticket._attachments;
        delete ticket._ts;

        // --- WYKONANIE ZAPISU ---
        
        // SCENARIUSZ 1: Zmiana kategorii (MIGRACJA PARTYCJI)
        // W Cosmos DB nie można zaktualizować Partition Key dokumentu.
        // Musimy usunąć stary dokument i utworzyć nowy w innej partycji logicznej.
        if (changes.category && changes.category !== originalCategory) {
            try {
                // Usuwamy ze starej partycji (używając ETag dla bezpieczeństwa)
                await ticketsContainer.item(ticketId, originalCategory).delete({ ifMatch: etag });
                // Tworzymy w nowej partycji
                const { resource: createdItem } = await ticketsContainer.items.create(ticket);
                context.res = { body: createdItem };
            } catch (err) {
                if (err.code === 412) {
                    context.res = { status: 412, body: { message: "Konflikt edycji (zmiana kategorii)." } };
                } else throw err;
            }
        } 
        // SCENARIUSZ 2: Standardowa aktualizacja (W TEJ SAMEJ PARTYCJI)
        else {
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