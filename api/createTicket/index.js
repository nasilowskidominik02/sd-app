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
 * ZMODYFIKOWANO: Funkcja teraz przyjmuje liczbę godzin (int), a nie kategorię.
 * Dzięki temu jest uniwersalna i zależy od ustawień z bazy.
 */
function calculateSLA(startDate, hoursToAdd) {
    // Zabezpieczenie na wypadek braku danych - domyślnie 8h
    let minutesToAdd = (hoursToAdd || 8) * 60;
    let currentDate = new Date(startDate);

    // Normalizuj datę startową do najbliższej godziny roboczej
    let day = currentDate.getDay();
    let hour = currentDate.getHours();
    
    // Logika dni wolnych i godzin pracy (08:00 - 16:00)
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

    // Pobieramy kategorię z requestu (jeśli frontend ją wyśle, jeśli nie - obsłużymy to niżej)
    const { title, content, attachment, category } = req.body;

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

        // KROK 2: Znajdź wybraną kategorię w ustawieniach
        // Jeśli frontend nie wysłał kategorii lub wysłał błędną, używamy "Inne" lub pierwszej dostępnej
        const targetCategoryName = category || "Inne";
        
        let categoryConfig = globalSettings.categories.find(c => c.name === targetCategoryName);
        
        // Fallback: jeśli nie znaleziono kategorii, weź "Inne" lub pierwszą z listy
        if (!categoryConfig) {
            categoryConfig = globalSettings.categories.find(c => c.name === "Inne") || globalSettings.categories[0];
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


        // KROK 4: Tworzenie zgłoszenia z dynamicznymi danymi
        const now = new Date();
        const newTicket = {
            id: newTicketId, 
            title: title,
            category: categoryConfig.name, // Używamy nazwy z konfiguracji (bezpieczniej)
            status: "Nieprzeczytane",
            content: content,
            reportingUser: {
                email: clientPrincipal.userDetails,
                name: clientPrincipal.userDetails 
            },
            assignedTo: {
                person: null,
                group: selectedGroup // Dynamicznie przypisana grupa z konfiguracji
            },
            dates: {
                createdAt: now.toISOString(),
                closedAt: null,
                // Przekazujemy liczbę godzin do kalkulatora
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