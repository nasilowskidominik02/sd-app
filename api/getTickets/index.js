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
            
            // === OPCJA: MOJA GRUPA ===
            if (quickFilter === 'my_group') {
                filterByMyGroups = true; // Włączamy filtrowanie grup w JS
                
                // A. Dodajemy filtr statusu do SQL (tylko otwarte)
                // To jest bezpieczne dla bazy i od razu odsieje zamknięte tickety
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");

                // B. Pobieramy grupy z ustawień (do filtrowania w JS)
                try {
                    const { resources: settings } = await container.items.query(
                        "SELECT * FROM c WHERE c.id = 'global_settings'",
                        { enableCrossPartitionQuery: true }
                    ).fetchAll();
                    
                    if (settings && settings.length > 0) {
                        const config = settings[0];
                        if (config.groups && Array.isArray(config.groups)) {
                            const userEmailLower = userEmail.toLowerCase().trim();
                            
                            // Zapisujemy nazwy grup (małymi literami)
                            myAllowedGroups = config.groups
                                .filter(g => g.members && g.members.some(m => m.toLowerCase().trim() === userEmailLower))
                                .map(g => g.name.toLowerCase().trim());
                        }
                    }
                } catch (err) {
                    context.log.error("Błąd pobierania grup:", err.message);
                }
            } 
            // === INNE FILTRY ===
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

        // --- 7. POBIERANIE DANYCH ---
        // Pobieramy surowe dane (SQL filtruje statusy i tekst, ale NIE grupy)
        const query = `SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c ${whereString}`;

        const { resources: rawTickets } = await container.items.query(
            { query, parameters },
            { enableCrossPartitionQuery: true }
        ).fetchAll();

        // --- 8. FILTROWANIE GRUP (JS), SORTOWANIE I PAGINACJA ---
        
        let processedTickets = rawTickets;

        // A. Filtrowanie grup w JS (tylko jeśli wybrano my_group)
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

        // C. Paginacja
        const totalCount = processedTickets.length;
        const totalPages = Math.ceil(totalCount / pageSize);
        const paginatedTickets = processedTickets.slice(offset, offset + pageSize);

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