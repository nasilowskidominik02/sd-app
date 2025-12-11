const { CosmosClient } = require("@azure/cosmos");

// OPTYMALIZACJA: Inicjalizacja połączeń poza funkcją
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const database = client.database("ServiceDeskDB");
const countersContainer = database.container("Counters");
const ticketsContainer = database.container("Tickets");

function padNumber(num, size) {
    let s = num + "";
    while (s.length < size) s = "0" + s;
    return s;
}

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

    let day = currentDate.getDay();
    let hour = currentDate.getHours();
    if (day === 6) { 
        currentDate.setDate(currentDate.getDate() + 2);
        currentDate.setHours(8, 0, 0, 0);
    } else if (day === 0) { 
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
        // Używamy globalnego countersContainer
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

        const now = new Date();
        const newTicket = {
            id: newTicketId, 
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
            comments: [] 
        };
        
        // Używamy globalnego ticketsContainer
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