const { CosmosClient } = require("@azure/cosmos");

/**
 * Funkcja pomocnicza do formatowania numeru z wiodącymi zerami (np. 1 -> "0001")
 */
function padNumber(num, size) {
    let s = num + "";
    while (s.length < size) s = "0" + s;
    return s;
}

/**
 * Oblicza gwarantowaną datę rozwiązania (SLA).
 */
function calculateSLA(startDate, category) {
    const slaHours = {
        "Instalacja oprogramowania": 4,
        "Konfiguracja oprogramowania": 4,
        "Hardware": 24,
        "Infrastruktura": 12,
        "Konto": 4,
        "Aplikacje": 48,
        "Inne": 8
    };

    let minutesToAdd = (slaHours[category] || 8) * 60;
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

    const { title, content, attachment } = req.body;

    if (!title || !content) {
        return { status: 400, body: "Please provide a title and content for the ticket." };
    }

    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const database = client.database("ServiceDeskDB");
        
        // --- LOGIKA GENEROWANIA NOWEGO ID ---
        const countersContainer = database.container("Counters");
        const { resource: counterDoc } = await countersContainer.item("ticketSequence", "ticketSequence").read();
        
        const currentYear = new Date().getFullYear();
        let nextNumber;

        if (counterDoc.year === currentYear) {
            nextNumber = counterDoc.lastNumber + 1;
        } else {
            nextNumber = 1; // Resetuj numerację dla nowego roku
            counterDoc.year = currentYear;
        }
        
        const newTicketId = `${currentYear}-${padNumber(nextNumber, 4)}`;
        
        // Zaktualizuj licznik w bazie
        counterDoc.lastNumber = nextNumber;
        await countersContainer.items.upsert(counterDoc);
        // --- KONIEC LOGIKI GENEROWANIA ID ---

        const now = new Date();
        const newTicket = {
            id: newTicketId, // Używamy naszego nowego, sekwencyjnego ID
            title: title,
            category: "Inne",
            status: "Nieprzeczytane",
            content: content,
            reportingUser: {
                email: clientPrincipal.userDetails,
                name: clientPrincipal.userDetails 
            },
            assignedTo: {
                person: null,
                group: "Pierwsza linia wsparcia"
            },
            dates: {
                createdAt: now.toISOString(),
                closedAt: null,
                guaranteedResolutionAt: calculateSLA(now, "Inne").toISOString()
            },
            attachments: attachment ? [attachment] : [],
            comments: [] // Inicjalizuj pustą tablicę na komentarze
        };
        
        const ticketsContainer = database.container("Tickets");
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

