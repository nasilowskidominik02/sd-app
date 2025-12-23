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
        // Ustalamy rozmiar strony na 10
        const page = parseInt(req.query.page) || 1;
        const pageSize = 10; 
        const offset = (page - 1) * pageSize;

        const rawSearch = req.query.search || '';
        const searchText = rawSearch.toLowerCase().trim();
        const searchField = req.query.field || 'id';
        const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');

        // --- 3. PRZYGOTOWANIE LOGIKI FILTRACJI ---
        let filterByMyGroups = false;
        let myAllowedGroups = []; 

        // --- 4. FILTRY SQL (WHERE) ---
        let whereClauses = [];
        let parameters = [];

        // Filtry techniczne
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

                try {
                    const { resources: settings } = await container.items.query(
                        "SELECT * FROM c WHERE c.id = 'global_settings'",
                        { enableCrossPartitionQuery: true }
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
                    context.log.error("Błąd grup:", err);
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

        let whereString = "";
        if (whereClauses.length > 0) {
            whereString = " WHERE " + whereClauses.join(" AND ");
        }

        // --- 6. POBIERANIE DANYCH (Fetch All & Slice in JS) ---
        const query = `SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c ${whereString}`;

        const { resources: rawTickets } = await container.items.query(
            { query, parameters },
            { enableCrossPartitionQuery: true }
        ).fetchAll();

        // --- 7. PRZETWARZANIE W PAMIĘCI ---
        let processedTickets = rawTickets;

        // A. Filtrowanie grup (jeśli wybrano filtr "Moje grupy")
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

        // B. Sortowanie (od najnowszych)
        processedTickets.sort((a, b) => {
            const dateA = a.dates && a.dates.createdAt ? new Date(a.dates.createdAt).getTime() : 0;
            const dateB = b.dates && b.dates.createdAt ? new Date(b.dates.createdAt).getTime() : 0;
            return dateB - dateA;
        });

        // C. OBLICZANIE STRON (Kluczowe dla naprawy błędu)
        const totalCount = processedTickets.length;
        const totalPages = Math.ceil(totalCount / pageSize); // Obliczamy ile jest stron
        
        // Wycinamy odpowiedni kawałek tablicy dla aktualnej strony
        const paginatedTickets = processedTickets.slice(offset, offset + pageSize);

        // --- 8. ZWROT DANYCH ---
        context.res = {
            body: {
                tickets: paginatedTickets,
                totalCount: totalCount,
                currentPage: page,
                totalPages: totalPages // Tu wysyłamy informację, której brakowało
            }
        };

    } catch (error) {
        context.log.error("ERROR:", error);
        context.res = { 
            status: 500, 
            body: { message: "Internal Server Error", details: error.message } 
        };
    }
};