const { CosmosClient } = require("@azure/cosmos");

// 1. OPTYMALIZACJA: Klient tworzony raz i trzymany w pamięci (Global Variable)
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: "User is not authenticated." };
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    const isServiceDesk = clientPrincipal.userRoles.includes('sd');
    const userEmail = clientPrincipal.userDetails;

    const page = parseInt(req.query.page) || 1;
    const searchId = req.query.searchId || '';
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    // Twoje zoptymalizowane zapytanie wybiórcze
    let query = "SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c";
    let countQuery = "SELECT VALUE COUNT(1) FROM c";
    let whereClauses = [];
    let parameters = [];

    if (!isServiceDesk) {
        whereClauses.push("c.reportingUser.email = @userEmail");
        parameters.push({ name: "@userEmail", value: userEmail });
    }

    if (searchId) {
        whereClauses.push("STARTSWITH(c.id, @searchId)");
        parameters.push({ name: "@searchId", value: searchId });
    }

    if (whereClauses.length > 0) {
        query += " WHERE " + whereClauses.join(" AND ");
        countQuery += " WHERE " + whereClauses.join(" AND ");
    }
    
    query += " ORDER BY c.dates.createdAt DESC OFFSET @offset LIMIT @limit";
    parameters.push({ name: "@offset", value: offset });
    parameters.push({ name: "@limit", value: pageSize });

    const querySpec = { query, parameters };
    const countParams = parameters.filter(p => p.name !== '@offset' && p.name !== '@limit');
    const countQuerySpec = { query: countQuery, parameters: countParams }; 
    
    try {
        // 2. OPTYMALIZACJA: Równoległe pobieranie danych i licznika (Promise.all)
        // Zamiast czekać na Count, a potem na Items, puszczamy oba zapytania naraz.
        const [countResponse, itemsResponse] = await Promise.all([
            container.items.query(countQuerySpec).fetchAll(),
            container.items.query(querySpec).fetchAll()
        ]);

        const totalCount = countResponse.resources[0];
        const items = itemsResponse.resources;

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