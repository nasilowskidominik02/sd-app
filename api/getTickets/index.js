const { CosmosClient } = require("@azure/cosmos");

module.exports = async function (context, req) {
    context.log('JavaScript HTTP trigger function processed a request to get tickets.');

    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: "User is not authenticated." };
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    const isServiceDesk = clientPrincipal.userRoles.includes('sd');
    const userEmail = clientPrincipal.userDetails;

    // --- Paginacja i Wyszukiwanie ---
    const page = parseInt(req.query.page) || 1;
    const searchId = req.query.searchId || '';
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    let query = "SELECT * FROM c";
    let countQuery = "SELECT VALUE COUNT(1) FROM c";
    let whereClauses = [];
    let parameters = [];

    // Filtrowanie dla zwykłego użytkownika
    if (!isServiceDesk) {
        whereClauses.push("c.reportingUser.email = @userEmail");
        parameters.push({ name: "@userEmail", value: userEmail });
    }

    // Filtrowanie po ID zgłoszenia
    if (searchId) {
        // Używamy STARTSWITH dla częściowego dopasowania
        whereClauses.push("STARTSWITH(c.id, @searchId)");
        parameters.push({ name: "@searchId", value: searchId });
    }

    if (whereClauses.length > 0) {
        query += " WHERE " + whereClauses.join(" AND ");
        countQuery += " WHERE " + whereClauses.join(" AND ");
    }
    
    // Dodanie sortowania i paginacji do głównego zapytania
    query += " ORDER BY c.dates.createdAt DESC OFFSET @offset LIMIT @limit";
    parameters.push({ name: "@offset", value: offset });
    parameters.push({ name: "@limit", value: pageSize });

    const querySpec = { query, parameters };
    const countQuerySpec = { query: countQuery, parameters: parameters.slice(0, parameters.length - 2) }; // Usuwamy parametry paginacji z zapytania liczącego

    try {
        const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
        const database = client.database("ServiceDeskDB");
        const container = database.container("Tickets");

        // Pobranie całkowitej liczby zgłoszeń do paginacji
        const { resources: countResult } = await container.items.query(countQuerySpec).fetchAll();
        const totalCount = countResult[0];

        // Pobranie zgłoszeń dla danej strony
        const { resources: items } = await container.items.query(querySpec).fetchAll();

        context.res = {
            body: {
                tickets: items,
                totalCount: totalCount,
                currentPage: page,
                totalPages: Math.ceil(totalCount / pageSize)
            }
        };

    } catch (error) {
        context.log.error(error);
        context.res = {
            status: 500,
            body: "Error connecting to or reading from the database"
        };
    }
};

