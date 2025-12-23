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
        
        // --- 2. PARAMETRY STRONICOWANIA ---
        // Tutaj ustalamy logikę: strona 1 -> offset 0, strona 2 -> offset 10 itd.
        const page = parseInt(req.query.page) || 1;
        const pageSize = 10;
        const offset = (page - 1) * pageSize;

        // Pozostałe parametry
        const rawSearch = req.query.search || '';
        const searchText = rawSearch.toLowerCase().trim();
        const searchField = req.query.field || 'id';
        const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');

        // --- 3. PRZYGOTOWANIE LOGIKI FILTRACJI (JS) ---
        let filterByMyGroups = false;
        let myAllowedGroups = []; 

        // --- 4. FILTRY SQL (WHERE) ---
        let whereClauses = [];
        let parameters = [];

        // Filtry techniczne (stałe)
        whereClauses.push("c.id != 'global_settings'");
        whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

        // Zwykły user widzi tylko swoje
        if (!isServiceDesk) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        // --- 5. LOGIKA FILTRÓW DLA SD ---
        if (isServiceDesk) {
            if (quickFilter === 'my_group') {
                filterByMyGroups = true; // Włączamy filtrowanie grup w JS
                
                // Pobieramy tylko otwarte, żeby nie mieliła bazy zamkniętymi
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");

                // Pobieramy definicje grup
                try {
                    const { resources: settings } = await container.items.query(
                        "SELECT * FROM c WHERE c.id = 'global_settings'"
                    ).fetchAll();
                    
                    if (settings && settings.length > 0) {
                        const config = settings[0];
                        if (config.groups && Array.isArray(config.groups)) {
                            const userEmailLower = userEmail.toLowerCase().trim();
                            myAllowedGroups = config.groups
                                .filter(g => g.members && g.members.some(m => m.toLowerCase().trim() === userEmailLower))
                                .map(g => g.name.toLowerCase().trim());
                        }
                    }
                } catch (err) {
                    context.log.error("Błąd pobierania grup:", err.message);
                }
            } 
            else if (quickFilter === 'open') {
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
            }
            else if (quickFilter === 'closed') {
                whereClauses.push("(c.status = 'Zamknięte' OR c.status = 'Rozwiązane' OR c.status = 'Odrzucone')");
            }
        }

        // --- 6. WYSZUKIWANIE TEKSTOWE ---
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

        // --- 7. POBIERANIE DANYCH (WSZYSTKIE PASUJĄCE) ---
        // Tutaj pobieramy wszystko co pasuje do SQL, a stronnicowanie zrobimy niżej w JS
        const query = `SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c ${whereString}`;

        const { resources: rawTickets } = await container.items.query(
            { query, parameters },
            { enableCrossPartitionQuery: true } // To jest kluczowe, żeby nie było błędów
        ).fetchAll();

        // --- 8. PRZETWARZANIE W PAMIĘCI (JS) ---
        
        let processedTickets = rawTickets;

        // A. Filtrowanie grup (jeśli dotyczy)
        if (filterByMyGroups) {
            if (myAllowedGroups.length === 0) {
                processedTickets = [];
            } else {
                processedTickets = processedTickets.filter(ticket => {
                    if (ticket.assignedTo && ticket.assignedTo.group) {
                        const ticketGroup = ticket.assignedTo.group.toLowerCase().trim();
                        return myAllowedGroups.includes(ticketGroup);
                    }
                    return false;
                });
            }
        }

        // B. Sortowanie (od najnowszych)
        processedTickets.sort((a, b) => {
            const dateA = a.dates && a.dates.createdAt ? new Date(a.dates.createdAt).getTime() : 0;
            const dateB = b.dates && b.dates.createdAt ? new Date(b.dates.createdAt).getTime() : 0;
            return dateB - dateA;
        });

        // C. STRONICOWANIE (Paginacja)
        // To jest moment, w którym realizujemy Twoje wymaganie:
        // "na stronie 1 załaduj 10 pierwszych, na stronie 2 kolejne 10"
        const totalCount = processedTickets.length;
        const totalPages = Math.ceil(totalCount / pageSize);
        
        // Wycinamy odpowiedni kawałek tablicy
        const paginatedTickets = processedTickets.slice(offset, offset + pageSize);

        context.res = {
            body: {
                tickets: paginatedTickets, // Zwracamy tylko 10 sztuk
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