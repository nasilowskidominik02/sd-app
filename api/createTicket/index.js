const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

/**
 * Oblicza gwarantowaną datę rozwiązania (SLA) na podstawie daty startowej i kategorii.
 * Uwzględnia tylko godziny robocze (pon-pt 8:00-16:00).
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

    let hoursToAdd = slaHours[category] || 8;
    let currentDate = new Date(startDate);
    
    while (hoursToAdd > 0) {
        currentDate.setHours(currentDate.getHours() + 1);
        const dayOfWeek = currentDate.getDay(); // 0=Niedziela, 6=Sobota
        const hourOfDay = currentDate.getHours();

        if (dayOfWeek >= 1 && dayOfWeek <= 5 && hourOfDay > 8 && hourOfDay <= 16) {
            hoursToAdd--;
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
        attachments: attachment ? [attachment] : []
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

