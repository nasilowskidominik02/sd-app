const { CosmosClient } = require("@azure/cosmos");

// Inicjalizacja klienta
const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    // Zmienne do diagnostyki błędów
    let executionStep = "Start";
    
    try {
        executionStep = "Auth Check";
        const header = req.headers['x-ms-client-principal'];
        if (!header) return { status: 401, body: { error: "Brak nagłówka autoryzacji" } };
        
        const encoded = Buffer.from(header, 'base64');
        const decoded = encoded.toString('ascii');
        const clientPrincipal = JSON.parse(decoded);

        if (!clientPrincipal || !clientPrincipal.userDetails) {
             return { status: 403, body: { error: "Błędne dane użytkownika" } };
        }

        const isServiceDesk = clientPrincipal.userRoles.includes('sd');
        const userEmail = clientPrincipal.userDetails;
        
        executionStep = "Parameter Parsing";
        const page = parseInt(req.query.page) || 1;
        const rawSearch = req.query.search || '';
        const searchText = rawSearch.toLowerCase().trim();
        const searchField = req.query.field || 'id';
        const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');
        const pageSize = 10;
        const offset = (page - 1) * pageSize;

        let query = "SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c";
        let countQuery = "SELECT VALUE COUNT(1) FROM c";
        let whereClauses = [];
        let parameters = [];

        // Filtry stałe
        whereClauses.push("c.id != 'global_settings'");
        whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

        if (!isServiceDesk) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        executionStep = "SD Filters Logic";
        if (isServiceDesk) {
            if (quickFilter === 'my_group') {
                executionStep = "Fetching Global Settings";
                let myGroups = [];
                let settingsError = null;

                try {
                    // PRÓBA 1: Najbezpieczniejsze zapytanie SQL z opcją CrossPartition
                    const settingsQuerySpec = { 
                        query: "SELECT * FROM c WHERE c.id = 'global_settings'" 
                    };
                    
                    const { resources: settings } = await container.items.query(
                        settingsQuerySpec,
                        { enableCrossPartitionQuery: true } 
                    ).fetchAll();
                    
                    if (settings && settings.length > 0) {
                        const config = settings[0];
                        if (config.groups && Array.isArray(config.groups)) {
                            const userEmailLower = userEmail.toLowerCase();
                            myGroups = config.groups
                                .filter(g => g.members && Array.isArray(g.members) && g.members.includes(userEmailLower))
                                .map(g => g.name);
                        }
                    }
                } catch (err) {
                    // Zapisujemy błąd, ale nie przerywamy
                    settingsError = err.message;
                    context.log.error("Settings fetch error:", err);
                }

                executionStep = "Building Group Query";
                if (myGroups.length > 0) {
                    const orConditions = myGroups.map((_, index) => `c.assignedTo.group = @g${index}`);
                    whereClauses.push(`(${orConditions.join(' OR ')})`);
                    myGroups.forEach((groupName, index) => {
                        parameters.push({ name: `@g${index}`, value: groupName });
                    });
                } else {
                    // Jeśli nie udało się pobrać grup lub user nie ma grup -> 0 wyników
                    // Dodajemy też info do logów, dlaczego jest 0 wyników
                    if (settingsError) {
                        context.log.warn(`Filtr my_group zwrócił 0 wyników z powodu błędu: ${settingsError}`);
                    }
                    whereClauses.push("1 = 0"); 
                }
            } 
            else if (quickFilter === 'open') {
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
            }
            else if (quickFilter === 'closed') {
                whereClauses.push("(c.status = 'Zamknięte' OR c.status = 'Rozwiązane' OR c.status = 'Odrzucone')");
            }
        }

        executionStep = "Search & Query Build";
        if (searchText) {
            let condition = "CONTAINS(LOWER(c.id), @search)"; // default
            if (searchField === 'title') condition = "CONTAINS(LOWER(c.title), @search)";
            if (searchField === 'user') condition = "(CONTAINS(LOWER(c.reportingUser.name), @search) OR CONTAINS(LOWER(c.reportingUser.email), @search))";
            if (searchField === 'category') condition = "CONTAINS(LOWER(c.category), @search)";
            if (searchField === 'assigned') condition = "(IS_DEFINED(c.assignedTo.person) AND CONTAINS(LOWER(c.assignedTo.person), @search))";
            if (searchField === 'group') condition = "CONTAINS(LOWER(c.assignedTo.group), @search)";
            // Proste zabezpieczenie dat
            if (searchField === 'created' || searchField === 'closed') condition = "STARTSWITH(c.dates.createdAt, @searchRaw)"; 

            whereClauses.push(condition);
            parameters.push({ name: "@search", value: searchText });
            // Dodajemy rawSearch tylko jeśli jest potrzebny (dla dat), żeby uniknąć warningów o nieużywanych parametrach
            if (searchField === 'created' || searchField === 'closed') {
                 parameters.push({ name: "@searchRaw", value: rawSearch.trim() });
            }
        }

        if (whereClauses.length > 0) {
            const whereString = " WHERE " + whereClauses.join(" AND ");
            query += whereString;
            countQuery += whereString;
        }
        
        query += " ORDER BY c.dates.createdAt DESC OFFSET @offset LIMIT @limit";
        parameters.push({ name: "@offset", value: offset });
        parameters.push({ name: "@limit", value: pageSize });

        executionStep = "Executing Query";
        
        // Oddzielamy parametry dla count (bez offset/limit)
        const countParams = parameters.filter(p => p.name !== '@offset' && p.name !== '@limit');
        
        const [countResponse, itemsResponse] = await Promise.all([
            container.items.query({ query: countQuery, parameters: countParams }).fetchAll(),
            container.items.query({ query, parameters }).fetchAll()
        ]);

        context.res = {
            body: {
                tickets: itemsResponse.resources,
                totalCount: countResponse.resources[0],
                currentPage: page,
                totalPages: Math.ceil(countResponse.resources[0] / pageSize),
                debugInfo: "Success"
            }
        };

    } catch (error) {
        context.log.error(`CRITICAL ERROR at step: ${executionStep}`, error);
        // Zwracamy kod 200 z polem error, żeby frontend to wyświetlił w konsoli JSON
        // lub 500 z ciałem JSON
        context.res = { 
            status: 500, 
            body: { 
                message: "Internal Server Error", 
                step: executionStep,
                details: error.message,
                stack: error.stack 
            } 
        };
    }
};