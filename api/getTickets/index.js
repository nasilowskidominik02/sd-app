const { CosmosClient } = require("@azure/cosmos");

module.exports = async function (context, req) {
    context.log('JavaScript HTTP trigger function processed a request to get tickets.');

    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        context.res = { status: 401, body: "User is not authenticated." };
        return;
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    const isServiceDesk = clientPrincipal.userRoles.includes('sd');
    const userEmail = clientPrincipal.userDetails;

    // --- Paginacja ---
    const page = parseInt(req.query.page) || 1;
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    let querySpec;
    let countQuerySpec;

    if (isServiceDesk) {
        // Pracownik SD widzi wszystkie zgłoszenia
        querySpec = {
            query: "SELECT * FROM c ORDER BY c.dates.createdAt DESC OFFSET @offset LIMIT @limit",
            parameters: [
                { name: "@offset", value: offset },
                { name: "@limit", value: pageSize }
            ]
        };
        countQuerySpec = { query: "SELECT VALUE COUNT(1) FROM c" };
    } else {
        // Użytkownik widzi tylko swoje zgłoszenia
        querySpec = {
            query: "SELECT * FROM c WHERE c.reportingUser.email = @userEmail ORDER BY c.dates.createdAt DESC OFFSET @offset LIMIT @limit",
            parameters: [
                { name: "@userEmail", value: userEmail },
                { name: "@offset", value: offset },
                { name: "@limit", value: pageSize }
            ]
        };
        countQuerySpec = {
            query: "SELECT VALUE COUNT(1) FROM c WHERE c.reportingUser.email = @userEmail",
            parameters: [{ name: "@userEmail", value: userEmail }]
        };
    }

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

