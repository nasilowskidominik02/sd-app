const { CosmosClient } = require("@azure/cosmos");

// Inicjalizacja połączeń
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
 * Funkcja obliczająca SLA na podstawie godzin roboczych
 */
function calculateSLA(startDate, hoursToAdd) {
    let minutesToAdd = (hoursToAdd || 8) * 60;
    let currentDate = new Date(startDate);

    // Normalizuj datę startową do najbliższej godziny roboczej
    let day = currentDate.getDay();
    let hour = currentDate.getHours();
    
    if (day === 6) { // Sobota
        currentDate.setDate(currentDate.getDate() + 2);
        currentDate.setHours(8, 0, 0, 0);
    } else if (day === 0) { // Niedziela
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate.setHours(8, 0, 0, 0);
    } else if (hour < 8) {
        currentDate.setHours(8, 0, 0, 0);
    } else if (hour >= 16) {
        currentDate.setDate(currentDate.getDate() + (day === 5 ? 3 : 1));
        currentDate.setHours(8, 0, 0, 0);
    }
    
    while (minutesToAdd > 0) {
        const endOfWorkDay = new Date(currentDate);
        endOfWorkDay.setHours(16, 0, 0, 0);
        
        const minutesLeftInDay = (endOfWorkDay - currentDate) / 60000;
        
        if (minutesToAdd <= minutesLeftInDay) {
            currentDate.setMinutes(currentDate.getMinutes() + minutesToAdd);
            minutesToAdd = 0;
        } else {
            minutesToAdd -= minutesLeftInDay;
            currentDate.setDate(currentDate.getDate() + (currentDate.getDay() === 5 ? 3 : 1));
            currentDate.setHours(8, 0, 0, 0);
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

    // POPRAWKA: Ignorujemy 'category' z wejścia, nawet jeśli ktoś by je wysłał.
    const { title, content, attachment } = req.body;

    if (!title || !content) {
        return { status: 400, body: "Please provide a title and content for the ticket." };
    }

    try {
        // KROK 1: Pobierz globalne ustawienia (Kategorie i SLA)
        const settingsQuery = { query: "SELECT * FROM c WHERE c.id = 'global_settings'" };
        const { resources: settingsItems } = await ticketsContainer.items.query(settingsQuery).fetchAll();
        
        const globalSettings = settingsItems.length > 0 ? settingsItems[0] : null;
        
        if (!globalSettings) {
            throw new Error("Brak konfiguracji 'global_settings' w bazie danych!");
        }

        // KROK 2: Wymuszamy kategorię "Inne"
        const targetCategoryName = "Inne";
        
        // Szukamy konfiguracji dla "Inne" w bazie danych
        let categoryConfig = globalSettings.categories.find(c => c.name === targetCategoryName);
        
        // Fallback: jeśli administrator usunął "Inne", bierzemy pierwszą dostępną kategorię
        if (!categoryConfig) {
            categoryConfig = globalSettings.categories[0];
        }

        const selectedSlaHours = categoryConfig.sla;
        const selectedGroup = categoryConfig.assignedGroup;


        // KROK 3: Generowanie ID (bez zmian)
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


        // KROK 4: Tworzenie zgłoszenia
        const now = new Date();
        const newTicket = {
            id: newTicketId, 
            title: title,
            category: categoryConfig.name, // Powinno być "Inne" (chyba że fallback zadziałał)
            status: "Nieprzeczytane",
            content: content,
            reportingUser: {
                email: clientPrincipal.userDetails,
                name: clientPrincipal.userDetails 
            },
            assignedTo: {
                person: null,
                group: selectedGroup // Dynamicznie przypisana grupa dla "Inne" (np. I linia)
            },
            dates: {
                createdAt: now.toISOString(),
                closedAt: null,
                guaranteedResolutionAt: calculateSLA(now, selectedSlaHours).toISOString()
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