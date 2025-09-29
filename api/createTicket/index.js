const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require('uuid');

/**
 * Oblicza gwarantowaną datę rozwiązania (SLA) na podstawie daty startowej i kategorii.
 * Uwzględnia tylko godziny robocze (pon-pt 8:00-16:00).
 * @param {string} startDateStr - Data startowa w formacie ISO.
 * @param {string} category - Kategoria zgłoszenia.
 * @returns {Date} - Obliczona data rozwiązania.
 */
function calculateSLA(startDateStr, category) {
    const slaHoursMap = {
        "Instalacja oprogramowania": 4,
        "Konfiguracja oprogramowania": 4,
        "Hardware": 24,
        "Infrastruktura": 12,
        "Konto": 4,
        "Aplikacje": 48,
        "Inne": 8
    };

    const businessHoursStart = 8;
    const businessHoursEnd = 16;

    let slaMinutesToAdd = (slaHoursMap[category] || 8) * 60;
    let resolutionDate = new Date(startDateStr);

    // Funkcja pomocnicza do przesuwania daty na początek następnego dnia roboczego
    const adjustToNextBusinessDay = () => {
        resolutionDate.setDate(resolutionDate.getDate() + 1);
        // Pomiń weekendy
        if (resolutionDate.getDay() === 6) { // Sobota
            resolutionDate.setDate(resolutionDate.getDate() + 2);
        } else if (resolutionDate.getDay() === 0) { // Niedziela
            resolutionDate.setDate(resolutionDate.getDate() + 1);
        }
        resolutionDate.setHours(businessHoursStart, 0, 0, 0);
    };

    // Krok 1: Normalizacja daty startowej do godzin roboczych
    // Jeśli zgłoszenie przyszło w weekend, przesuń na poniedziałek 8:00
    if (resolutionDate.getDay() === 6 || resolutionDate.getDay() === 0) {
        adjustToNextBusinessDay();
    }
    // Jeśli po godzinach pracy, przesuń na następny dzień roboczy o 8:00
    else if (resolutionDate.getHours() >= businessHoursEnd) {
        adjustToNextBusinessDay();
    }
    // Jeśli przed godzinami pracy, ustaw na 8:00 tego samego dnia
    else if (resolutionDate.getHours() < businessHoursStart) {
        resolutionDate.setHours(businessHoursStart, 0, 0, 0);
    }
    
    // Krok 2: Dodaj minuty SLA, uwzględniając tylko czas roboczy
    while (slaMinutesToAdd > 0) {
        const endOfBusinessDay = new Date(resolutionDate);
        endOfBusinessDay.setHours(businessHoursEnd, 0, 0, 0);
        
        const minutesLeftInDay = (endOfBusinessDay.getTime() - resolutionDate.getTime()) / 60000;

        if (slaMinutesToAdd <= minutesLeftInDay) {
            // Możemy rozwiązać zgłoszenie tego samego dnia
            resolutionDate.setMinutes(resolutionDate.getMinutes() + slaMinutesToAdd);
            slaMinutesToAdd = 0;
        } else {
            // Musimy przenieść pozostały czas na następny dzień roboczy
            slaMinutesToAdd -= minutesLeftInDay;
            adjustToNextBusinessDay();
        }
    }

    return resolutionDate;
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
    const defaultCategory = "Inne";
    const newTicket = {
        id: uuidv4(), 
        title: title,
        category: defaultCategory,
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
            guaranteedResolutionAt: calculateSLA(now, defaultCategory).toISOString()
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

