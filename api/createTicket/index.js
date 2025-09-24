const { CosmosClient } = require("@azure/cosmos");

/**
 * Oblicza gwarantowaną datę rozwiązania (SLA) na podstawie daty startowej i kategorii.
 * Uwzględnia tylko godziny robocze (pon-pt 8:00-16:00).
 * @param {Date} startDate - Data i godzina rozpoczęcia liczenia.
 * @param {string} category - Kategoria zgłoszenia.
 * @returns {Date} Obliczona data SLA.
 */
function calculateSLA(startDate, category) {
    const slaHours = {
        "Instalacja oprogramowania": 4,
        "Konfiguracja oprogramowania": 4,
        "Hardware": 24,
        "Infrastruktura": 12,
        "Konto": 4,
        "Aplikacje": 48,
        "Nieprzypisane": 8 // Domyślne SLA, jeśli kategoria nie jest jeszcze znana
    };

    let hoursToAdd = slaHours[category] || 8; // Pobierz godziny SLA lub użyj domyślnej wartości
    let currentDate = new Date(startDate);
    
    while (hoursToAdd > 0) {
        currentDate.setHours(currentDate.getHours() + 1);
        const dayOfWeek = currentDate.getDay(); // 0=Niedziela, 6=Sobota
        const hourOfDay = currentDate.getHours();

        // Liczymy tylko dni robocze (poniedziałek-piątek) w godzinach 8-16
        if (dayOfWeek >= 1 && dayOfWeek <= 5 && hourOfDay > 8 && hourOfDay <= 16) {
            hoursToAdd--;
        }
    }
    return currentDate;
}


module.exports = async function (context, req) {
    context.log('JavaScript HTTP trigger function processed a request to create a ticket.');

    // Krok 1: Pobierz dane zalogowanego użytkownika z nagłówka
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        context.res = { status: 401, body: "User is not authenticated." };
        return;
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    // Krok 2: Pobierz dane zgłoszenia z ciała żądania
    const { title, content, attachment } = req.body;

    if (!title || !content) {
        context.res = { status: 400, body: "Please provide a title and content for the ticket." };
        return;
    }

    // Krok 3: Przygotuj kompletny obiekt nowego zgłoszenia
    const now = new Date();
    const newTicket = {
        title: title,
        category: "Nieprzypisane", // Domyślna kategoria, zgodnie z ustaleniami
        status: "Nowe",
        content: content,
        reportingUser: {
            email: clientPrincipal.userDetails,
            name: clientPrincipal.userDetails 
        },
        assignedTo: {
            person: null, // Na razie nikt nie jest przypisany indywidualnie
            group: "Pierwsza linia wsparcia"
        },
        dates: {
            createdAt: now.toISOString(),
            closedAt: null,
            guaranteedResolutionAt: calculateSLA(now, "Nieprzypisane").toISOString()
        },
        attachments: attachment ? [attachment] : [] // Dodaj załącznik, jeśli został przesłany
    };

    // Krok 4: Zapisz zgłoszenie w bazie danych
    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const database = client.database("ServiceDeskDB");
        const container = database.container("Tickets");

        const { resource: createdItem } = await container.items.create(newTicket);

        context.res = {
            status: 201, // 201 Created - standardowa odpowiedź po pomyślnym utworzeniu zasobu
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

