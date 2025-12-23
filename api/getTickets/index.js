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
        
        // --- 2. PARAMETRY (NOWE) ---
        // Zamiast "page" i "offset", pobieramy token kontynuacji
        const pageSize = 10;
        const continuationToken = req.headers['x-continuation-token'] || req.query.continuationToken || null;

        const rawSearch = req.query.search || '';
        const searchText = rawSearch.toLowerCase().trim();
        const searchField = req.query.field || 'id';
        const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');

        // --- 3. PRZYGOTOWANIE LOGIKI GRUP ---
        let filterByMyGroups = false;
        let myAllowedGroups = []; 

        // --- 4. FILTRY SQL (WHERE) ---
        let whereClauses = [];
        let parameters = [];

        whereClauses.push("c.id != 'global_settings'");
        whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

        if (!isServiceDesk) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        if (isServiceDesk) {
            if (quickFilter === 'my_group') {
                filterByMyGroups = true;
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
                // Pobieranie grup z bazy... (bez zmian logicznych)
                try {
                    const { resources: settings } = await container.items.query(
                        "SELECT * FROM c WHERE c.id = 'global_settings'"
                    ).fetchAll();
                    if (settings && settings.length > 0 && settings[0].groups) {
                        const userEmailLower = userEmail.toLowerCase().trim();
                        myAllowedGroups = settings[0].groups
                            .filter(g => g.members && g.members.some(m => m.toLowerCase().trim() === userEmailLower))
                            .map(g => g.name.toLowerCase().trim());
                    }
                } catch (err) {}
            } else if (quickFilter === 'open') {
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
            } else if (quickFilter === 'closed') {
                whereClauses.push("(c.status = 'Zamknięte' OR c.status = 'Rozwiązane' OR c.status = 'Odrzucone')");
            }
        }

        if (searchText) {
            // ... (logika wyszukiwania bez zmian) ...
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

        // --- 5. WYKONANIE ZAPYTANIA Z TOKENEM ---
        
        // Zauważ: Dodajemy ORDER BY, co jest wymagane dla spójności stron,
        // ale usuwamy OFFSET/LIMIT. Limit obsługuje `maxItemCount`.
        const query = `
            SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates 
            FROM c 
            ${whereString} 
            ORDER BY c.dates.createdAt DESC
        `;

        // Tworzymy iterator
        const iterator = container.items.query(
            { query, parameters },
            { 
                maxItemCount: pageSize, // Tu definiujemy rozmiar strony (10)
                continuationToken: continuationToken, // Tu przekazujemy token z frontendu
                enableCrossPartitionQuery: true 
            }
        );

        // Pobieramy TYLKO jedną stronę wyników
        const { resources: rawTickets, hasMoreResults, continuationToken: nextToken } = await iterator.fetchNext();

        // --- 6. FILTROWANIE GRUP W PAMIĘCI (To nadal musi zostać w JS dla tego filtra) ---
        // Uwaga: To jest "haczyk" przy tokenach. Jeśli odfiltrujemy wszystko w JS, 
        // możemy zwrócić pustą stronę mimo istnienia tokena. 
        // W prostym wdrożeniu akceptujemy to (użytkownik zobaczy pustą stronę i kliknie dalej).
        
        let processedTickets = rawTickets || [];

        if (filterByMyGroups) {
             if (myAllowedGroups.length === 0) {
                processedTickets = [];
            } else {
                processedTickets = processedTickets.filter(ticket => {
                    if (ticket.assignedTo && ticket.assignedTo.group) {
                        return myAllowedGroups.includes(ticket.assignedTo.group.toLowerCase().trim());
                    }
                    return false;
                });
            }
        }

        // --- 7. LICZNIK CAŁKOWITY (Dla informacji "Znaleziono X zgłoszeń") ---
        // To wykonujemy oddzielnie, żeby wiedzieć ile jest w sumie, ale nie wpływa to na paginację
        const countQuerySpec = {
            query: `SELECT VALUE COUNT(1) FROM c ${whereString}`,
            parameters: parameters
        };
        const { resources: countRes } = await container.items.query(countQuerySpec, { enableCrossPartitionQuery: true }).fetchAll();
        const totalCount = countRes[0];

        context.res = {
            body: {
                tickets: processedTickets,
                totalCount: totalCount,
                continuationToken: nextToken // Zwracamy token do następnej strony
            }
        };

    } catch (error) {
        context.log.error("ERROR:", error);
        context.res = { status: 500, body: { message: "Error", details: error.message } };
    }
};