const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const countersContainer = database.container("Counters");
const ticketsContainer = database.container("Tickets");

/**
 * Formatuje numer do postaci ciągu znaków o zadanej długości, uzupełniając go zerami z przodu.
 * Jest to niezbędne do generowania identyfikatorów zgłoszeń (np. 2025-0042), 
 * które muszą zachowywać stały format i sortować się poprawnie.
 *
 * @param {number} num - Liczba do sformatowania (np. 5).
 * @param {number} size - Oczekiwana długość wynikowego ciągu (np. 4).
 * @returns {string} Sformatowany ciąg znaków (np. "0005").
 */
function padNumber(num, size) {
    let s = num + "";
    while (s.length < size) s = "0" + s;
    return s;
}

/**
 * Oblicza datę SLA (gwarantowany czas rozwiązania) uwzględniając kalendarz pracy.
 * Algorytm przesuwa termin realizacji, pomijając godziny nocne, weekendy oraz święta.
 *
 * @param {Date|string} startDate - Data początkowa (utworzenia zgłoszenia).
 * @param {number} hoursToAdd - Czas SLA w godzinach (przypisany do kategorii).
 * @param {Object} workConfig - Konfiguracja godzin pracy (startHour, endHour, holidays).
 * @returns {Date} Obliczona data, do której zgłoszenie musi zostać rozwiązane.
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

        // Jeśli to dzień wolny (weekend/święto), przesuń na następny dzień rano
        if (isWeekend || isHoliday) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
            continue; 
        }

        const currentHour = currentDate.getHours();

        // Przed godzinami pracy -> ustaw na początek zmiany
        if (currentHour < startHour) {
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        // Po godzinach pracy -> przesuń na następny dzień rano
        if (currentHour >= endHour) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        // Oblicz dostępny czas w bieżącym dniu
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
 * Główna funkcja Azure Function obsługująca tworzenie nowego zgłoszenia.
 * Odpowiada za:
 * 1. Walidację danych wejściowych i uprawnień.
 * 2. Pobranie ustawień globalnych (dla SLA i grup).
 * 3. Generowanie sekwencyjnego ID z blokadą optymistyczną (zapobieganie duplikatom).
 * 4. Zapis zgłoszenia w bazie Cosmos DB.
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure.
 * @param {Object} req - Obiekt żądania HTTP zawierający dane zgłoszenia.
 * @returns {Object} Zwraca obiekt odpowiedzi HTTP (201 Created z utworzonym zgłoszeniem lub błąd).
 */
module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: "User is not authenticated." };
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    const { title, content, attachment, onBehalfOf } = req.body;

    if (!title || !content) {
        return { status: 400, body: "Please provide a title and content for the ticket." };
    }

    try {
        let finalReportingUserEmail = clientPrincipal.userDetails;
        
        // Logika "w imieniu" (tylko dla SD)
        if (clientPrincipal.userRoles.includes('sd') && onBehalfOf && onBehalfOf.trim() !== "") {
            finalReportingUserEmail = onBehalfOf.trim();
        }

        // KROK 1: Konfiguracja
        const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
        const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
        
        const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;
        if (!globalSettings) throw new Error("Brak konfiguracji 'global_settings' w bazie danych!");

        const workConfig = globalSettings.workConfig || { startHour: 8, endHour: 16, holidays: [] };

        // KROK 2: Ustalanie kategorii
        const targetCategoryName = "Inne";
        let categoryConfig = globalSettings.categories.find(c => c.name === targetCategoryName);
        if (!categoryConfig) categoryConfig = globalSettings.categories[0];

        const selectedSlaHours = categoryConfig.sla;
        const selectedGroup = categoryConfig.assignedGroup;

        // KROK 3: Generowanie ID (Optimistic Concurrency Control)
        let retryCount = 0;
        const maxRetries = 10;
        let newTicketId = null;

        while (retryCount < maxRetries) {
            try {
                // Pobieramy licznik wraz z jego ETagiem
                const { resource: counterDoc, etag } = await countersContainer.item("ticketSequence", "ticketSequence").read();
                
                if (!counterDoc) {
                    throw new Error("Dokument licznika 'ticketSequence' nie istnieje.");
                }

                const currentYear = new Date().getFullYear();
                let nextNumber;

                if (counterDoc.year === currentYear) {
                    nextNumber = counterDoc.lastNumber + 1;
                } else {
                    nextNumber = 1; 
                    counterDoc.year = currentYear;
                }

                counterDoc.lastNumber = nextNumber;

                // Próba zapisu z warunkiem zgodności ETag
                await countersContainer.item("ticketSequence", "ticketSequence").replace(counterDoc, { ifMatch: etag });

                newTicketId = `${currentYear}-${padNumber(nextNumber, 4)}`;
                break; // Sukces

            } catch (err) {
                // Obsługa konfliktu (412) - ponawiamy próbę
                if (err.code === 412) {
                    retryCount++;
                    if (retryCount >= maxRetries) {
                        throw new Error("Serwer jest obciążony. Nie udało się wygenerować ID zgłoszenia. Spróbuj ponownie.");
                    }
                } else {
                    throw err;
                }
            }
        }

        // KROK 4: Finalizacja obiektu
        const now = new Date();
        const slaDate = calculateAdvancedSLA(now, selectedSlaHours, workConfig);

        const newTicket = {
            id: newTicketId, 
            title: title,
            category: categoryConfig.name, 
            status: "Nieprzeczytane",
            content: content,
            reportingUser: {
                email: finalReportingUserEmail,
                name: finalReportingUserEmail
            },
            assignedTo: {
                person: null,
                group: selectedGroup 
            },
            dates: {
                createdAt: now.toISOString(),
                closedAt: null,
                guaranteedResolutionAt: slaDate.toISOString() 
            },
            attachments: attachment ? [attachment] : [],
            comments: [] 
        };
        
        const { resource: createdItem } = await ticketsContainer.items.create(newTicket);

        context.res = {
            status: 201,
            body: createdItem
        };
    } catch (error) {
        context.log.error("CreateTicket Error:", error);
        context.res = {
            status: 500,
            body: "Error connecting to or writing to the database: " + error.message
        };
    }
};