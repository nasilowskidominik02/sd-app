const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

/**
 * Oblicza gwarantowaną datę rozwiązania (SLA).
 * Uwzględnia tylko minuty robocze (pon-pt 8:00-16:00).
 */
function calculateSLA(startDate, category) {
    const slaHours = {
        "Instalacja oprogramowania": 4,
        "Konfiguracja oprogramowania": 4,
        "Hardware": 24,
        "Infrastruktura": 12,
        "Konto": 4,
        "Aplikacje": 48,
        "Inne": 8 // Domyślne SLA dla nowo utworzonych zgłoszeń
    };

    let minutesToAdd = (slaHours[category] || 8) * 60;
    let currentDate = new Date(startDate);
    
    // Ustawienie początkowej daty na początek dnia roboczego, jeśli jest poza godzinami
    const day = currentDate.getDay();
    const hour = currentDate.getHours();
    if (day === 6) { // Sobota
        currentDate.setDate(currentDate.getDate() + 2);
        currentDate.setHours(8, 0, 0, 0);
    } else if (day === 0) { // Niedziela
        currentDate.setDate(currentDate.getDate() + 1);
        currentDate.setHours(8, 0, 0, 0);
    } else if (hour < 8) {
        currentDate.setHours(8, 0, 0, 0);
    } else if (hour >= 16) {
        currentDate.setDate(currentDate.getDate() + (day === 5 ? 3 : 1)); // Jeśli piątek, przeskocz na poniedziałek
        currentDate.setHours(8, 0, 0, 0);
    }

    while (minutesToAdd > 0) {
        const endOfWorkingDay = new Date(currentDate);
        endOfWorkingDay.setHours(16, 0, 0, 0);

        const minutesLeftInDay = (endOfWorkingDay - currentDate) / 60000;

        if (minutesToAdd <= minutesLeftInDay) {
            currentDate.setMinutes(currentDate.getMinutes() + minutesToAdd);
            minutesToAdd = 0;
        } else {
            minutesToAdd -= minutesLeftInDay;
            // Przeskocz do następnego dnia roboczego
            currentDate.setDate(currentDate.getDate() + (currentDate.getDay() === 5 ? 3 : 1));
            currentDate.setHours(8, 0, 0, 0);
        }
    }
    return currentDate;
}

module.exports = async function (context, req) {
    context.log('JavaScript HTTP trigger function processed a request to create a ticket.');

    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        context.res = { status: 401, body: "User is not authenticated." };
        return;
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    const { title, content, attachment } = req.body;

    if (!title || !content) {
        context.res = { status: 400, body: "Please provide a title and content for the ticket." };
        return;
    }

    const now = new Date();
    const newTicket = {
        id: uuidv4(), // Generuje unikalny, niezmienny identyfikator
        title: title,
        category: "Inne", // Domyślna kategoria
        status: "Nieprzeczytane", // Domyślny status
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
        comments: [] // Dodajemy pustą tablicę na komentarze
    };

    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const database = client.database("ServiceDeskDB");
        const container = database.container("Tickets");

        const { resource: createdItem } = await container.items.create(newTicket);

        context.res = {
            status: 201,
            body: createdItem
        };
    } catch (error) {
        context.log.error(error);
        context.res = {
            status: 500,
            body: "Error connecting to or writing to the database."
        };
    }
};

