const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const countersContainer = database.container("Counters");
const ticketsContainer = database.container("Tickets");

function padNumber(num, size) {
    let s = num + "";
    while (s.length < size) s = "0" + s;
    return s;
}

/**
 * ZAAWANSOWANE OBLICZANIE SLA (WORK CALENDAR)
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
        
        if (clientPrincipal.userRoles.includes('sd') && onBehalfOf && onBehalfOf.trim() !== "") {
            finalReportingUserEmail = onBehalfOf.trim();
        }

        // KROK 1: Pobierz globalne ustawienia
        const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
        const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
        
        const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;
        if (!globalSettings) throw new Error("Brak konfiguracji 'global_settings' w bazie danych!");

        const workConfig = globalSettings.workConfig || { startHour: 8, endHour: 16, holidays: [] };

        // KROK 2: Kategoria i SLA
        const targetCategoryName = "Inne";
        let categoryConfig = globalSettings.categories.find(c => c.name === targetCategoryName);
        if (!categoryConfig) categoryConfig = globalSettings.categories[0];

        const selectedSlaHours = categoryConfig.sla;
        const selectedGroup = categoryConfig.assignedGroup;

        // =================================================================================
        // KROK 3: ID Zgłoszenia z zabezpieczeniem przed wyścigiem (Optimistic Concurrency)
        // =================================================================================
        let retryCount = 0;
        const maxRetries = 10;
        let newTicketId = null;

        while (retryCount < maxRetries) {
            try {
                // A. Pobieramy licznik I JEGO ETAG (wersję)
                const { resource: counterDoc, etag } = await countersContainer.item("ticketSequence", "ticketSequence").read();
                
                if (!counterDoc) {
                    throw new Error("Dokument licznika 'ticketSequence' nie istnieje.");
                }

                const currentYear = new Date().getFullYear();
                let nextNumber;

                // Logika inkrementacji
                if (counterDoc.year === currentYear) {
                    nextNumber = counterDoc.lastNumber + 1;
                } else {
                    nextNumber = 1; 
                    counterDoc.year = currentYear;
                }

                // Aktualizujemy obiekt w pamięci
                counterDoc.lastNumber = nextNumber;

                // B. Próbujemy zapisać Z WARUNKIEM ifMatch
                // To rzuci błąd 412, jeśli etag w bazie jest inny niż ten, który odczytaliśmy
                await countersContainer.item("ticketSequence", "ticketSequence").replace(counterDoc, { ifMatch: etag });

                // Jeśli przeszliśmy tutaj, to znaczy, że się udało (nikt nas nie ubiegł)
                newTicketId = `${currentYear}-${padNumber(nextNumber, 4)}`;
                break; // Wychodzimy z pętli while

            } catch (err) {
                // Kod 412: Precondition Failed (Ktoś zmienił dokument w międzyczasie)
                if (err.code === 412) {
                    retryCount++;
                    // Kontynuujemy pętlę -> pobierzemy nowszą wersję i spróbujemy jeszcze raz
                    if (retryCount >= maxRetries) {
                        throw new Error("Serwer jest obciążony. Nie udało się wygenerować ID zgłoszenia. Spróbuj ponownie.");
                    }
                } else {
                    // Inny błąd - rzucamy dalej
                    throw err;
                }
            }
        }
        // =================================================================================

        // KROK 4: Obliczamy SLA
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