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
 * * @param {Date} startDate - Data utworzenia zgłoszenia
 * @param {number} hoursToAdd - Czas SLA w godzinach
 * @param {Object} workConfig - Konfiguracja { startHour, endHour, holidays: [] }
 */
function calculateAdvancedSLA(startDate, hoursToAdd, workConfig) {
    // Domyślne wartości, jeśli brak konfiguracji
    const startHour = workConfig?.startHour || 8;
    const endHour = workConfig?.endHour || 16;
    const holidays = workConfig?.holidays || []; // Format 'YYYY-MM-DD'

    let minutesRemaining = hoursToAdd * 60;
    let currentDate = new Date(startDate); // Kopia daty startowej

    // Pętla "skacząca", dopóki nie zużyjemy całego czasu SLA
    while (minutesRemaining > 0) {
        
        // 1. Sprawdź, czy dzisiaj jest dzień pracujący (nie weekend, nie święto)
        const dayOfWeek = currentDate.getDay(); // 0=Niedziela, 6=Sobota
        const dateString = currentDate.toISOString().split('T')[0];
        const isHoliday = holidays.includes(dateString);
        const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);

        if (isWeekend || isHoliday) {
            // Przeskocz do następnego dnia, ustaw godzinę na start pracy
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
            continue; // Wróć na początek pętli
        }

        // 2. Obsługa godzin pracy wewnątrz dnia roboczego
        const currentHour = currentDate.getHours();
        const currentMinute = currentDate.getMinutes();

        // A. Jeśli jest PRZED pracą -> ustaw na start pracy
        if (currentHour < startHour) {
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        // B. Jeśli jest PO pracy -> przeskocz do następnego dnia rano
        if (currentHour >= endHour) {
            currentDate.setDate(currentDate.getDate() + 1);
            currentDate.setHours(startHour, 0, 0, 0);
            continue;
        }

        // C. Jesteśmy w godzinach pracy! Liczymy ile minut zostało do końca dnia pracy.
        // Koniec pracy dzisiaj:
        const endOfWorkDay = new Date(currentDate);
        endOfWorkDay.setHours(endHour, 0, 0, 0);

        const msUntilEndOfDay = endOfWorkDay - currentDate;
        const minutesUntilEndOfDay = Math.floor(msUntilEndOfDay / 60000);

        if (minutesUntilEndOfDay >= minutesRemaining) {
            // Zmieścimy się dzisiaj! Dodajemy resztę minut i kończymy.
            currentDate.setMinutes(currentDate.getMinutes() + minutesRemaining);
            minutesRemaining = 0;
        } else {
            // Nie zmieścimy się dzisiaj. Zużywamy to co zostało z dnia...
            minutesRemaining -= minutesUntilEndOfDay;
            // ...i przeskakujemy do następnego dnia rano
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

        // KROK 1: Pobierz globalne ustawienia (Kategorie, SLA, Kalendarz)
        const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
        const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
        
        const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;
        if (!globalSettings) throw new Error("Brak konfiguracji 'global_settings' w bazie danych!");

        // Pobieramy konfigurację kalendarza
        const workConfig = globalSettings.workConfig || { startHour: 8, endHour: 16, holidays: [] };

        // KROK 2: Kategoria i SLA
        const targetCategoryName = "Inne";
        let categoryConfig = globalSettings.categories.find(c => c.name === targetCategoryName);
        if (!categoryConfig) categoryConfig = globalSettings.categories[0];

        const selectedSlaHours = categoryConfig.sla;
        const selectedGroup = categoryConfig.assignedGroup;

        // KROK 3: ID Zgłoszenia
        const { resource: counterDoc } = await countersContainer.item("ticketSequence", "ticketSequence").read();
        const currentYear = new Date().getFullYear();
        let nextNumber;

        if (counterDoc.year === currentYear) {
            nextNumber = counterDoc.lastNumber + 1;
        } else {
            nextNumber = 1; 
            counterDoc.year = currentYear;
        }
        
        const newTicketId = `${currentYear}-${padNumber(nextNumber, 4)}`;
        counterDoc.lastNumber = nextNumber;
        await countersContainer.items.upsert(counterDoc);

        // KROK 4: Obliczamy SLA z uwzględnieniem kalendarza
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
                guaranteedResolutionAt: slaDate.toISOString() // Data wyliczona inteligentnie
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
            body: "Error connecting to or writing to the database."
        };
    }
};