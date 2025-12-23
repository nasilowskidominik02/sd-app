const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

/**
 * Pobiera listę zgłoszeń z obsługą stronicowania, wyszukiwania i filtrowania.
 * * Funkcja implementuje hybrydowy model przetwarzania danych:
 * 1. Wstępna filtracja na poziomie bazy danych (SQL) dla prostych warunków.
 * 2. Zaawansowana filtracja i paginacja w pamięci aplikacji (JavaScript).
 * * Takie podejście (pobranie wszystkich pasujących metadanych i cięcie w JS) zostało wybrane,
 * aby umożliwić elastyczne filtrowanie "Moje Grupy", które wymaga dynamicznego
 * sprawdzania przynależności użytkownika do grup zdefiniowanych w oddzielnym dokumencie konfiguracji.
 *
 * @param {Object} context - Kontekst wykonania Azure Function.
 * @param {Object} req - Obiekt żądania HTTP.
 * @param {number} [req.query.page=1] - Numer strony (domyślnie 1).
 * @param {string} [req.query.search] - Fraza wyszukiwania.
 * @param {string} [req.query.field='id'] - Pole, po którym odbywa się wyszukiwanie.
 * @param {string} [req.query.quickFilter] - Szybki filtr ('my_group', 'open', 'closed', 'all').
 * @returns {Object} Obiekt zawierający:
 * - tickets: Tablica zgłoszeń dla bieżącej strony.
 * - totalCount: Całkowita liczba zgłoszeń spełniających kryteria.
 * - totalPages: Liczba wszystkich stron (kluczowe dla renderowania paginacji UI).
 */
module.exports = async function (context, req) {
    try {
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
        
        // Konfiguracja paginacji
        const page = parseInt(req.query.page) || 1;
        const pageSize = 10; 
        const offset = (page - 1) * pageSize;

        const rawSearch = req.query.search || '';
        const searchText = rawSearch.toLowerCase().trim();
        const searchField = req.query.field || 'id';
        // Domyślny filtr: SD widzi "Swoje grupy", User widzi "Wszystkie swoje"
        const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');

        let filterByMyGroups = false;
        let myAllowedGroups = []; 

        // Budowanie dynamicznego zapytania SQL
        let whereClauses = [];
        let parameters = [];

        // Wykluczenie dokumentów systemowych i konfiguracyjnych
        whereClauses.push("c.id != 'global_settings'");
        whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

        // Zwykły użytkownik widzi tylko swoje zgłoszenia
        if (!isServiceDesk) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        if (isServiceDesk) {
            if (quickFilter === 'my_group') {
                filterByMyGroups = true;
                // Ukrywamy zamknięte, aby serwisanci skupili się na bieżącej pracy
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");

                // Pobranie konfiguracji grup w celu ustalenia uprawnień użytkownika.
                // Robimy to w osobnym zapytaniu, ponieważ Cosmos DB nie obsługuje JOIN-ów między kontenerami/dokumentami.
                try {
                    const { resources: settings } = await container.items.query(
                        "SELECT * FROM c WHERE c.id = 'global_settings'",
                        { enableCrossPartitionQuery: true }
                    ).fetchAll();
                    
                    if (settings && settings.length > 0) {
                        const config = settings[0];
                        if (config.groups && Array.isArray(config.groups)) {
                            const userEmailLower = userEmail.toLowerCase().trim();
                            // Znajdź grupy, do których należy bieżący użytkownik
                            myAllowedGroups = config.groups
                                .filter(g => g.members && g.members.some(m => m.toLowerCase().trim() === userEmailLower))
                                .map(g => g.name.toLowerCase().trim());
                        }
                    }
                } catch (err) {
                    context.log.error("Błąd pobierania konfiguracji grup:", err);
                }
            } 
            else if (quickFilter === 'open') {
                whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
            }
            else if (quickFilter === 'closed') {
                whereClauses.push("(c.status = 'Zamknięte' OR c.status = 'Rozwiązane' OR c.status = 'Odrzucone')");
            }
        }

        // Obsługa wyszukiwania pełnotekstowego
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

        // Pobieramy tylko niezbędne pola do listy, aby zredukować zużycie RU i transfer danych
        const query = `SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c ${whereString}`;

        const { resources: rawTickets } = await container.items.query(
            { query, parameters },
            { enableCrossPartitionQuery: true }
        ).fetchAll();

        let processedTickets = rawTickets;

        // Filtracja w pamięci dla "Moje Grupy".
        // Ponieważ lista grup użytkownika jest dynamiczna i pochodzi z innego dokumentu,
        // efektywniej jest przefiltrować wyniki w JS niż budować skomplikowany WHERE IN (...).
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

        // Sortowanie malejąco po dacie utworzenia
        processedTickets.sort((a, b) => {
            const dateA = a.dates && a.dates.createdAt ? new Date(a.dates.createdAt).getTime() : 0;
            const dateB = b.dates && b.dates.createdAt ? new Date(b.dates.createdAt).getTime() : 0;
            return dateB - dateA;
        });

        // Symulacja paginacji (Slice).
        // Obliczamy całkowitą liczbę stron na podstawie przefiltrowanego zbioru danych.
        // Jest to niezbędne dla poprawnego działania komponentu paginacji na frontendzie.
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
        context.log.error("ERROR:", error);
        context.res = { 
            status: 500, 
            body: { message: "Internal Server Error", details: error.message } 
        };
    }
};