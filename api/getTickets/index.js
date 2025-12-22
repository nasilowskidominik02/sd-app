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
        let query = "SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c";
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
                
                // Używamy bezpiecznego POINT READ
                try {
                    const { resource: config } = await container
                        .item("global_settings", "config")
                        .read();
                    
                    if (config && config.groups && Array.isArray(config.groups)) {
                        const userEmailLower = userEmail.toLowerCase().trim(); // Trim dla pewności
                        
                        myGroups = config.groups
                            .filter(g => {
                                // Sprawdzamy czy members istnieje i czy zawiera maila
                                if (!g.members || !Array.isArray(g.members)) return false;
                                // Bezpieczne sprawdzenie (mail w bazie też może mieć spacje/wielkość liter)
                                return g.members.some(m => m.toLowerCase().trim() === userEmailLower);
                            })
                            .map(g => g.name);
                    }
                } catch (err) {
                    context.log.error("Błąd pobierania ustawień:", err.message);
                }

                if (myGroups.length > 0) {
                    // --- ZMIANA: IGNOROWANIE WIELKOŚCI LITER ---
                    
                    // 1. Zamieniamy nazwy grup z ustawień na małe litery
                    const safeGroups = myGroups
                        .map(g => `'${g.toLowerCase().trim().replace(/'/g, "''")}'`)
                        .join(", ");
                    
                    // 2. W SQL używamy LOWER(), żeby nazwa w zgłoszeniu też była traktowana jako małe litery
                    // Zapytanie wygląda teraz: LOWER(c.assignedTo.group) IN ('administratorzy aplikacji', ...)
                    whereClauses.push(`LOWER(c.assignedTo.group) IN (${safeGroups})`);

                } else {
                    // Debug: Logujemy, że nie znaleziono grup dla tego użytkownika
                    context.log.warn(`Użytkownik SD ${userEmail} wybrał 'my_group', ale nie znaleziono go w żadnej grupie w global_settings.`);
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
        if (whereClauses.length > 0) {
            const whereString = " WHERE " + whereClauses.join(" AND ");
            query += whereString;
            countQuery += whereString;
        }
        
        query += ` ORDER BY c.dates.createdAt DESC OFFSET ${offset} LIMIT ${pageSize}`;

        const [countResponse, itemsResponse] = await Promise.all([
            container.items.query({ query: countQuery, parameters: parameters }).fetchAll(),
            container.items.query({ query: query, parameters: parameters }).fetchAll()
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