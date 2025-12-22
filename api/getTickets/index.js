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
        
        // Obliczamy offset dla JS (nie dla SQL)
        const offset = (page - 1) * pageSize;

        // --- 3. PRZYGOTOWANIE FILTRÓW (WHERE) ---
        let whereClauses = [];
        let parameters = [];

        // Filtry obowiązkowe
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
                
                // Pobieramy ustawienia (SQL Query - najbezpieczniejsze)
                try {
                    const { resources: settings } = await container.items.query(
                        "SELECT * FROM c WHERE c.id = 'global_settings'",
                        { enableCrossPartitionQuery: true }
                    ).fetchAll();
                    
                    if (settings && settings.length > 0) {
                        const config = settings[0];
                        if (config.groups && Array.isArray(config.groups)) {
                            const userEmailLower = userEmail.toLowerCase().trim();
                            
                            myGroups = config.groups
                                .filter(g => g.members && g.members.some(m => m.toLowerCase().trim() === userEmailLower))
                                .map(g => g.name);
                        }
                    }
                } catch (err) {
                    context.log.error("Settings fetch error:", err.message);
                }

                if (myGroups.length > 0) {
                    // Budujemy warunki OR z StringEquals
                    const groupConditions = myGroups.map(groupName => {
                        const safeName = groupName.replace(/'/g, "''");
                        return `StringEquals(c.assignedTo.group, '${safeName}', true)`;
                    });
                    
                    // (Grupa A lub Grupa B)
                    whereClauses.push(`(${groupConditions.join(' OR ')})`);

                } else {
                    // SD bez grupy -> brak wyników
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

        // --- 6. WYKONANIE ZAPYTANIA (BEZ ORDER BY i OFFSET W SQL) ---
        
        let whereString = "";
        if (whereClauses.length > 0) {
            whereString = " WHERE " + whereClauses.join(" AND ");
        }

        // Pobieramy WSZYSTKIE pasujące rekordy (ograniczamy tylko polami SELECT, żeby było lekko)
        // Zauważ brak ORDER BY i OFFSET/LIMIT - to eliminuje błąd bazy danych.
        const query = `SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c ${whereString}`;

        const { resources: allMatchingTickets } = await container.items.query(
            { query, parameters },
            { enableCrossPartitionQuery: true }
        ).fetchAll();

        // --- 7. SORTOWANIE I PAGINACJA W JAVASCRIPT (Backend) ---
        
        // Sortujemy malejąco po dacie (od najnowszych)
        // JavaScript robi to w pamięci RAM, co jest bardzo szybkie dla < 1000 elementów
        allMatchingTickets.sort((a, b) => {
            const dateA = new Date(a.dates.createdAt).getTime();
            const dateB = new Date(b.dates.createdAt).getTime();
            return dateB - dateA;
        });

        const totalCount = allMatchingTickets.length;
        const totalPages = Math.ceil(totalCount / pageSize);

        // Wycinamy odpowiedni kawałek tablicy (Paginacja)
        // np. strona 1: od 0 do 10, strona 2: od 10 do 20
        const paginatedTickets = allMatchingTickets.slice(offset, offset + pageSize);

        context.res = {
            body: {
                tickets: paginatedTickets,
                totalCount: totalCount,
                currentPage: page,
                totalPages: totalPages
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