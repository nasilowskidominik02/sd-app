const { CosmosClient } = require("@azure/cosmos");

module.exports = async function (context, req) {
    context.log('JavaScript HTTP trigger function processed a request to get tickets.');

    // Krok 1: Pobierz informacje o zalogowanym użytkowniku z nagłówka
    const header = req.headers["x-ms-client-principal"];
    if (!header) {
        context.res = { status: 401, body: "Brak uwierzytelnienia. Użytkownik nie jest zalogowany." };
        return;
    }
    const encoded = Buffer.from(header, "base64");
    const clientPrincipal = JSON.parse(encoded.toString("ascii"));
    
    const userRoles = clientPrincipal.userRoles;
    const userEmail = clientPrincipal.userDetails;

    // Krok 2: Połącz się z bazą danych Cosmos DB
    const connectionString = process.env.COSMOS_DB_CONNECTION_STRING;
    if (!connectionString) {
        context.res = { status: 500, body: "Brak skonfigurowanego klucza do bazy danych."};
        return;
    }
    const client = new CosmosClient(connectionString);
    const database = client.database("ServiceDeskDB");
    const container = database.container("Tickets");

    let querySpec;

    // Krok 3: Zbuduj zapytanie do bazy w zależności od roli użytkownika
    if (userRoles.includes('sd')) {
        // Użytkownik z rolą 'sd' widzi wszystkie zgłoszenia, posortowane od najnowszych
        context.log('Użytkownik SD - pobieranie wszystkich zgłoszeń.');
        querySpec = {
            query: "SELECT * FROM c ORDER BY c.dates.createdAt DESC"
        };
    } else {
        // Zwykły użytkownik widzi tylko swoje zgłoszenia
        context.log(`Użytkownik ${userEmail} - pobieranie własnych zgłoszeń.`);
        querySpec = {
            query: "SELECT * FROM c WHERE c.reportingUser.email = @userEmail ORDER BY c.dates.createdAt DESC",
            parameters: [
                { name: "@userEmail", value: userEmail }
            ]
        };
    }

    // Krok 4: Wykonaj zapytanie i zwróć wyniki
    try {
        const { resources: items } = await container.items.query(querySpec).fetchAll();
        context.res = {
            // status: 200, /* domyślnie */
            body: items
        };
    } catch (err) {
        context.log.error("Błąd podczas pobierania danych z Cosmos DB:", err);
        context.res = {
            status: 500,
            body: "Wystąpił błąd podczas komunikacji z bazą danych."
        };
    }
};

