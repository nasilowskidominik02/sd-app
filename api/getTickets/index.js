const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: "User is not authenticated." };
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    const isServiceDesk = clientPrincipal.userRoles.includes('sd');
    const userEmail = clientPrincipal.userDetails;
    
    // Pobieramy parametry
    const page = parseInt(req.query.page) || 1;
    // 'search' to nasza nowa, uniwersalna fraza
    const searchText = req.query.search ? req.query.search.toLowerCase() : ''; 
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    let query = "SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c";
    let countQuery = "SELECT VALUE COUNT(1) FROM c";
    let whereClauses = [];
    let parameters = [];

    // --- FILTRACJA PODSTAWOWA ---
    whereClauses.push("c.id != 'global_settings'");
    whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

    // Jeśli to zwykły user, widzi tylko swoje
    if (!isServiceDesk) {
        whereClauses.push("c.reportingUser.email = @userEmail");
        parameters.push({ name: "@userEmail", value: userEmail });
    }

    // --- WYSZUKIWANIE UNIWERSALNE ---
    if (searchText) {
        // Sprawdzamy wiele pól naraz używając OR
        // Używamy LOWER() aby ignorować wielkość liter (Case Insensitive)
        whereClauses.push(`(
            CONTAINS(LOWER(c.id), @search) OR
            CONTAINS(LOWER(c.title), @search) OR
            CONTAINS(LOWER(c.status), @search) OR
            CONTAINS(LOWER(c.category), @search) OR
            CONTAINS(LOWER(c.reportingUser.name), @search) OR
            CONTAINS(LOWER(c.reportingUser.email), @search) OR
            (IS_DEFINED(c.assignedTo.person) AND CONTAINS(LOWER(c.assignedTo.person), @search)) OR
            CONTAINS(LOWER(c.assignedTo.group), @search)
        )`);
        parameters.push({ name: "@search", value: searchText });
    }

    if (whereClauses.length > 0) {
        const whereString = " WHERE " + whereClauses.join(" AND ");
        query += whereString;
        countQuery += whereString;
    }
    
    query += " ORDER BY c.dates.createdAt DESC OFFSET @offset LIMIT @limit";
    parameters.push({ name: "@offset", value: offset });
    parameters.push({ name: "@limit", value: pageSize });

    const querySpec = { query, parameters };
    // Do countQuery bierzemy parametry bez offset/limit
    const countParams = parameters.filter(p => p.name !== '@offset' && p.name !== '@limit');
    const countQuerySpec = { query: countQuery, parameters: countParams }; 
    
    try {
        const [countResponse, itemsResponse] = await Promise.all([
            container.items.query(countQuerySpec).fetchAll(),
            container.items.query(querySpec).fetchAll()
        ]);

        context.res = {
            body: {
                tickets: itemsResponse.resources,
                totalCount: countResponse.resources[0],
                currentPage: page,
                totalPages: Math.ceil(countResponse.resources[0] / pageSize)
            }
        };

    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: "Error connecting to DB" };
    }
};