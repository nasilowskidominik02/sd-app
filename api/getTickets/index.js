const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    // Zmienna do zbierania logów, które wyślemy na frontend
    let debugLog = [];
    const log = (msg) => {
        context.log(msg);
        debugLog.push(msg);
    };

    try {
        log("1. Start funkcji getTickets");

        // --- AUTORYZACJA ---
        const header = req.headers['x-ms-client-principal'];
        if (!header) return { status: 401, body: "Brak nagłówka autoryzacji" };
        
        const encoded = Buffer.from(header, 'base64');
        const decoded = encoded.toString('ascii');
        const clientPrincipal = JSON.parse(decoded);

        const isServiceDesk = clientPrincipal.userRoles.includes('sd');
        const userEmail = clientPrincipal.userDetails;

        log(`2. Zalogowany jako: '${userEmail}'`);
        log(`2a. Rola SD: ${isServiceDesk}`);

        // --- PARAMETRY ---
        const page = parseInt(req.query.page) || 1;
        const searchText = (req.query.search || '').toLowerCase().trim();
        const searchField = req.query.field || 'id';
        const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');
        const pageSize = 10;
        const offset = (page - 1) * pageSize;

        log(`3. Wybrany filtr: '${quickFilter}'`);

        // --- BUDOWANIE ZAPYTANIA ---
        let query = "SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c";
        let countQuery = "SELECT VALUE COUNT(1) FROM c";
        let whereClauses = [];
        let parameters = [];

        whereClauses.push("c.id != 'global_settings'");
        whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

        if (!isServiceDesk) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        // --- DIAGNOSTYKA GRUP ---
        if (isServiceDesk && quickFilter === 'my_group') {
            log("4. Rozpoczynam pobieranie ustawień global_settings...");
            let myGroups = [];
            
            try {
                // Point Read
                const { resource: config } = await container.item("global_settings", "config").read();
                
                if (!config) {
                    log("!!! BŁĄD: Nie znaleziono dokumentu global_settings (id='global_settings', pk='config')");
                } else {
                    log("4a. Pobrano global_settings. Sprawdzam grupy...");
                    
                    if (config.groups && Array.isArray(config.groups)) {
                        const userEmailLower = userEmail.toLowerCase().trim();
                        
                        config.groups.forEach(g => {
                            log(`   - Sprawdzam grupę: '${g.name}'`);
                            if (g.members && Array.isArray(g.members)) {
                                // Logujemy członków, żebyś widział co jest w bazie
                                log(`     Członkowie: ${JSON.stringify(g.members)}`);
                                
                                const isMember = g.members.some(m => m.toLowerCase().trim() === userEmailLower);
                                if (isMember) {
                                    log(`     >>> SUKCES! Znaleziono użytkownika w grupie: ${g.name}`);
                                    myGroups.push(g.name);
                                } else {
                                    log(`     --- Użytkownik '${userEmailLower}' NIE pasuje do żadnego z członków.`);
                                }
                            } else {
                                log("     (Grupa nie ma tablicy members)");
                            }
                        });
                    } else {
                        log("!!! BŁĄD: Brak tablicy 'groups' w ustawieniach.");
                    }
                }
            } catch (err) {
                log(`!!! WYJĄTEK podczas pobierania ustawień: ${err.message}`);
            }

            if (myGroups.length > 0) {
                log(`5. Użytkownik należy do grup: ${JSON.stringify(myGroups)}`);
                const safeGroups = myGroups.map(g => `'${g.toLowerCase().trim().replace(/'/g, "''")}'`).join(", ");
                whereClauses.push(`LOWER(c.assignedTo.group) IN (${safeGroups})`);
            } else {
                log("5. !!! UWAGA: Tablica myGroups jest pusta. Użytkownik nie został znaleziony w żadnej grupie.");
                log("   -> Dodaję warunek 1=0 (brak wyników).");
                whereClauses.push("1 = 0");
            }
        }

        // --- WYSZUKIWANIE ---
        if (searchText) {
            let condition = "CONTAINS(LOWER(c.id), @search)";
            if (searchField === 'assigned') condition = "(IS_DEFINED(c.assignedTo.person) AND CONTAINS(LOWER(c.assignedTo.person), @search))";
            // ... reszta pól uproszczona dla czytelności debuggera ...
            whereClauses.push(condition);
            parameters.push({ name: "@search", value: searchText });
        }

        if (whereClauses.length > 0) {
            query += " WHERE " + whereClauses.join(" AND ");
            countQuery += " WHERE " + whereClauses.join(" AND ");
        }

        query += ` ORDER BY c.dates.createdAt DESC OFFSET ${offset} LIMIT ${pageSize}`;

        log(`6. Generowane zapytanie SQL: ${query}`);

        const [countResponse, itemsResponse] = await Promise.all([
            container.items.query({ query: countQuery, parameters: parameters }).fetchAll(),
            container.items.query({ query: query, parameters: parameters }).fetchAll()
        ]);

        context.res = {
            body: {
                tickets: itemsResponse.resources,
                totalCount: countResponse.resources[0],
                currentPage: page,
                // PRZEKAZUJEMY LOGI DO PRZEGLĄDARKI
                debugLog: debugLog 
            }
        };

    } catch (error) {
        context.res = { 
            status: 500, 
            body: { message: "Internal Error", log: debugLog, error: error.message } 
        };
    }
};