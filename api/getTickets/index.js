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

        // --- 3. PRZYGOTOWANIE LOGIKI GRUP (PRZED ZAPYTANIEM GŁÓWNYM) ---
        // Musimy ustalić grupy ZANIM zbudujemy SQL, aby użyć ich w klauzuli WHERE
        let myAllowedGroups = [];
        
        if (isServiceDesk && quickFilter === 'my_group') {
            try {
                // Pobieramy ustawienia tylko raz, aby wydobyć grupy użytkownika
                const { resources: settings } = await container.items.query(
                    "SELECT * FROM c WHERE c.id = 'global_settings'"
                ).fetchAll();
                
                if (settings && settings.length > 0) {
                    const config = settings[0];
                    if (config.groups && Array.isArray(config.groups)) {
                        const userEmailLower = userEmail.toLowerCase().trim();
                        // Pobieramy nazwy grup, do których należy user
                        myAllowedGroups = config.groups
                            .filter(g => g.members && g.members.some(m => m.toLowerCase().trim() === userEmailLower))
                            .map(g => g.name); // Zachowujemy oryginalną wielkość liter lub normalizujemy w zależności od danych
                    }
                }

                // OPTYMALIZACJA: Jeśli wybrano filtr "Moje grupy", a user nie ma grup -> Zwracamy pusto od razu
                if (myAllowedGroups.length === 0) {
                    return {
                        body: { tickets: [], totalCount: 0, currentPage: page, totalPages: 0 }
                    };
                }

            } catch (err) {
                context.log.error("Błąd pobierania grup:", err.message);
                // Kontynuujemy (zwróci pustą listę lub błąd w zależności od strategii)
            }
        }

        // --- 4. BUDOWANIE ZAPYTANIA SQL (WHERE) ---
        let whereClauses = [];
        let parameters = [];

        // Filtry techniczne
        whereClauses.push("c.id != 'global_settings'");
        whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

        // Zwykły user widzi tylko swoje
        if (!isServiceDesk) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        // Logika filtrów dla SD
        if (isServiceDesk) {
            if (quickFilter === 'my_group') {
                // STATUSY: Tylko otwarte (zgodnie z oryginalną logiką)
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
                
                // GRUPY: SQL IN / ARRAY_CONTAINS
                // Używamy ARRAY_CONTAINS, aby sprawdzić czy grupa zgłoszenia jest na liście usera
                whereClauses.push("ARRAY_CONTAINS(@myGroups, c.assignedTo.group)");
                parameters.push({ name: "@myGroups", value: myAllowedGroups });

            } else if (quickFilter === 'open') {
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
            } else if (quickFilter === 'closed') {
                whereClauses.push("(c.status = 'Zamknięte' OR c.status = 'Rozwiązane' OR c.status = 'Odrzucone')");
            }
            // 'all' nie dodaje dodatkowych warunków WHERE
        }

        // Wyszukiwanie tekstowe
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

        let whereString = "";
        if (whereClauses.length > 0) {
            whereString = " WHERE " + whereClauses.join(" AND ");
        }

        // --- 5. WYKONANIE ZAPYTAŃ (COUNT + DATA) ---
        
        // A. Zapytanie o licznik (Total Count)
        const countQuerySpec = {
            query: `SELECT VALUE COUNT(1) FROM c ${whereString}`,
            parameters: parameters
        };

        // B. Zapytanie o dane (Paginacja SQL)
        // Dodajemy parametry limit i offset
        const queryParameters = [...parameters, 
            { name: "@offset", value: offset }, 
            { name: "@limit", value: pageSize }
        ];

        const dataQuerySpec = {
            query: `
                SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates 
                FROM c 
                ${whereString} 
                ORDER BY c.dates.createdAt DESC 
                OFFSET @offset LIMIT @limit
            `,
            parameters: queryParameters
        };

        // Wykonujemy zapytania równolegle dla lepszej wydajności
        const [countResponse, dataResponse] = await Promise.all([
            container.items.query(countQuerySpec).fetchAll(),
            container.items.query(dataQuerySpec).fetchAll()
        ]);

        const totalCount = countResponse.resources[0];
        const tickets = dataResponse.resources;
        const totalPages = Math.ceil(totalCount / pageSize);

        context.res = {
            body: {
                tickets: tickets,
                totalCount: totalCount,
                currentPage: page,
                totalPages: totalPages
            }
        };

    } catch (error) {
        context.log.error("CRITICAL ERROR in getTickets:", error);
        context.res = { 
            status: 500, 
            body: { 
                message: "Internal Server Error", 
                details: error.message 
            } 
        };
    }
};