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
    
    const page = parseInt(req.query.page) || 1;
    
    // Pobieramy parametry wyszukiwania
    const searchText = req.query.search ? req.query.search.toLowerCase().trim() : '';
    const searchField = req.query.field || 'id'; // Domyślnie szukaj po ID
    
    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    let query = "SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c";
    let countQuery = "SELECT VALUE COUNT(1) FROM c";
    let whereClauses = [];
    let parameters = [];

    // --- FILTRY PODSTAWOWE ---
    whereClauses.push("c.id != 'global_settings'");
    whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

    if (!isServiceDesk) {
        whereClauses.push("c.reportingUser.email = @userEmail");
        parameters.push({ name: "@userEmail", value: userEmail });
    }

    // --- LOGIKA WYSZUKIWANIA PO KONKRETNYM POLU ---
    if (searchText) {
        let condition = "";
        
        switch (searchField) {
            case 'id':
                // ID często wpisujemy fragmentami, np. "2025"
                condition = "CONTAINS(LOWER(c.id), @search)";
                break;
            case 'title':
                condition = "CONTAINS(LOWER(c.title), @search)";
                break;
            case 'user':
                // Szukamy w nazwie LUB w emailu zgłaszającego
                condition = "(CONTAINS(LOWER(c.reportingUser.name), @search) OR CONTAINS(LOWER(c.reportingUser.email), @search))";
                break;
            case 'category':
                condition = "CONTAINS(LOWER(c.category), @search)";
                break;
            case 'assigned':
                // Sprawdzamy czy pole istnieje, a potem szukamy
                condition = "(IS_DEFINED(c.assignedTo.person) AND CONTAINS(LOWER(c.assignedTo.person), @search))";
                break;
            case 'group':
                condition = "CONTAINS(LOWER(c.assignedTo.group), @search)";
                break;
            case 'created':
                // Data utworzenia (np. wpisanie "2025-12-12" znajdzie wszystkie z tego dnia)
                // Używamy STARTSWITH na stringu daty ISO (np. 2025-12-12T15:00...)
                condition = "STARTSWITH(c.dates.createdAt, @searchRaw)";
                break;
            case 'closed':
                // Data zamknięcia
                condition = "(IS_DEFINED(c.dates.closedAt) AND STARTSWITH(c.dates.closedAt, @searchRaw))";
                break;
            default:
                // Domyślnie po ID
                condition = "CONTAINS(LOWER(c.id), @search)";
        }

        whereClauses.push(condition);
        parameters.push({ name: "@search", value: searchText });
        // Dla dat używamy oryginalnej wielkości liter (choć cyfry to bez znaczenia, to dobra praktyka)
        parameters.push({ name: "@searchRaw", value: req.query.search.trim() });
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