const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    try {
        // --- 1. AUTORYZACJA ---
        const header = req.headers['x-ms-client-principal'];
        if (!header) return { status: 401, body: "User is not authenticated." };
        
        const encoded = Buffer.from(header, 'base64');
        const decoded = encoded.toString('ascii');
        const clientPrincipal = JSON.parse(decoded);

        if (!clientPrincipal || !clientPrincipal.userDetails) {
             return { status: 403, body: "Invalid user details." };
        }

        const isServiceDesk = clientPrincipal.userRoles.includes('sd');
        const userEmail = clientPrincipal.userDetails;
        
        // --- 2. PARAMETRY ---
        const page = parseInt(req.query.page) || 1;
        const rawSearch = req.query.search || '';
        const searchText = rawSearch.toLowerCase().trim();
        const searchField = req.query.field || 'id';
        const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');
        const pageSize = 10;
        const offset = (page - 1) * pageSize;

        // --- 3. PRZYGOTOWANIE BAZY ZAPYTANIA ---
        let countQuery = "SELECT VALUE COUNT(1) FROM c";
        let whereClauses = [];
        let parameters = [];

        // Filtry podstawowe
        whereClauses.push("c.id != 'global_settings'");
        whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

        if (!isServiceDesk) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        // --- 4. LOGIKA FILTRÓW DLA SD ---
        if (isServiceDesk) {
            if (quickFilter === 'my_group') {
                let myGroups = [];
                
                // Pobieranie ustawień - wciąż używamy SQL z CrossPartition, bo to zadziałało w logach
                try {
                    const { resources: settings } = await container.items.query(
                        "SELECT * FROM c WHERE c.id = 'global_settings'",
                        { enableCrossPartitionQuery: true }
                    ).fetchAll();
                    
                    if (settings && settings.length > 0) {
                        const config = settings[0];
                        if (config.groups && Array.isArray(config.groups)) {
                            const userEmailLower = userEmail.toLowerCase().trim();
                            
                            // Znajdź grupy usera
                            myGroups = config.groups
                                .filter(g => {
                                    if (!g.members || !Array.isArray(g.members)) return false;
                                    return g.members.some(m => m.toLowerCase().trim() === userEmailLower);
                                })
                                .map(g => g.name);
                        }
                    }
                } catch (err) {
                    context.log.error("Błąd pobierania ustawień:", err.message);
                }

                if (myGroups.length > 0) {
                    // Budujemy warunki StringEquals
                    const groupConditions = myGroups.map(groupName => {
                        const safeName = groupName.replace(/'/g, "''");
                        return `StringEquals(c.assignedTo.group, '${safeName}', true)`;
                    });
                    
                    // DODATKOWE ZABEZPIECZENIE: Sprawdzamy czy assignedTo w ogóle istnieje
                    // Żeby nie wywołać błędu na starych zgłoszeniach bez przypisania
                    const groupsCheck = `(${groupConditions.join(' OR ')})`;
                    whereClauses.push(`(IS_DEFINED(c.assignedTo) AND IS_DEFINED(c.assignedTo.group) AND ${groupsCheck})`);

                } else {
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

        // --- 5. WYSZUKIWANIE TEKSTOWE ---
        if (searchText) {
            let condition = "";
            switch (searchField) {
                case 'id': condition = "CONTAINS(LOWER(c.id), @search)"; break;
                case 'title': condition = "CONTAINS(LOWER(c.title), @search)"; break;
                case 'user': condition = "(CONTAINS(LOWER(c.reportingUser.name), @search) OR CONTAINS(LOWER(c.reportingUser.email), @search))"; break;
                case 'category': condition = "CONTAINS(LOWER(c.category), @search)"; break;
                case 'assigned': condition = "(IS_DEFINED(c.assignedTo.person) AND CONTAINS(LOWER(c.assignedTo.person), @search))"; break;
                case 'group': condition = "CONTAINS(LOWER(c.assignedTo.group), @search)"; break;
                case 'created': condition = "STARTSWITH(c.dates.createdAt, @searchRaw)"; break;
                case 'closed': condition = "(IS_DEFINED(c.dates.closedAt) AND STARTSWITH(c.dates.closedAt, @searchRaw))"; break;
                default: condition = "CONTAINS(LOWER(c.id), @search)";
            }
            whereClauses.push(condition);
            parameters.push({ name: "@search", value: searchText });
            
            if (searchField === 'created' || searchField === 'closed') {
                parameters.push({ name: "@searchRaw", value: rawSearch.trim() });
            }
        }

        // --- 6. SKŁADANIE ZAPYTANIA ---
        let whereString = "";
        if (whereClauses.length > 0) {
            whereString = " WHERE " + whereClauses.join(" AND ");
        }

        const finalCountQuery = countQuery + whereString;
        const finalQuery = `SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c ${whereString} ORDER BY c.dates.createdAt DESC OFFSET ${offset} LIMIT ${pageSize}`;

        // --- KLUCZOWA POPRAWKA ---
        // Dodajemy { enableCrossPartitionQuery: true } do GŁÓWNYCH zapytań.
        // To jest wymagane, gdy używamy ORDER BY + OFFSET w zapytaniu, które nie ma w WHERE klucza partycji.
        // Bez tego baza zwraca "Invalid input values" (błąd 500).
        
        const queryOptions = { enableCrossPartitionQuery: true };

        const [countResponse, itemsResponse] = await Promise.all([
            container.items.query({ query: finalCountQuery, parameters: parameters }, queryOptions).fetchAll(),
            container.items.query({ query: finalQuery, parameters: parameters }, queryOptions).fetchAll()
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
        context.log.error("CRITICAL ERROR:", error);
        context.res = { 
            status: 500, 
            body: { 
                message: "Internal Server Error", 
                details: error.message 
            } 
        };
    }
};