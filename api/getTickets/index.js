const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    let debugLog = [];
    const log = (msg) => debugLog.push(msg);

    // Zmienne do raportu końcowego
    let finalQuery = "";
    let finalParameters = [];

    try {
        log("1. START");

        // --- AUTH ---
        const header = req.headers['x-ms-client-principal'];
        if (!header) throw new Error("Brak nagłówka auth");
        const clientPrincipal = JSON.parse(Buffer.from(header, 'base64').toString('ascii'));
        const isSD = clientPrincipal.userRoles.includes('sd');
        const userEmail = clientPrincipal.userDetails;
        log(`2. User: ${userEmail}, Role SD: ${isSD}`);

        // --- PARAMS ---
        const page = parseInt(req.query.page) || 1;
        const quickFilter = req.query.quickFilter || (isSD ? 'my_group' : 'all');
        const offset = (page - 1) * 10;
        log(`3. Filter: ${quickFilter}, Offset: ${offset}`);

        let whereClauses = ["c.id != 'global_settings'", "(NOT IS_DEFINED(c.type) OR c.type != 'notification')"];
        let parameters = [];

        if (!isSD) {
            whereClauses.push("c.reportingUser.email = @userEmail");
            parameters.push({ name: "@userEmail", value: userEmail });
        }

        // --- LOGIKA GRUP ---
        if (isSD && quickFilter === 'my_group') {
            log("4. Pobieranie ustawień...");
            
            // Testujemy SQL Query do ustawień (najbardziej kompatybilne)
            try {
                const settingsRes = await container.items.query(
                    "SELECT * FROM c WHERE c.id = 'global_settings'",
                    { enableCrossPartitionQuery: true }
                ).fetchAll();
                
                const settings = settingsRes.resources;
                log(`4a. Znaleziono ustawień: ${settings.length}`);

                if (settings.length > 0) {
                    const groups = settings[0].groups || [];
                    log(`4b. Dostępne grupy w bazie: ${groups.map(g => g.name).join(', ')}`);
                    
                    const userGroups = groups
                        .filter(g => g.members && g.members.some(m => m.toLowerCase().trim() === userEmail.toLowerCase().trim()))
                        .map(g => g.name);
                    
                    log(`4c. Znalezione grupy użytkownika: ${JSON.stringify(userGroups)}`);

                    if (userGroups.length > 0) {
                        // Budowanie warunku OR
                        const conditions = userGroups.map(g => {
                            const safe = g.replace(/'/g, "''");
                            return `StringEquals(c.assignedTo.group, '${safe}', true)`;
                        });
                        whereClauses.push(`(${conditions.join(' OR ')})`);
                    } else {
                        log("4d. Brak grup dla usera -> 1=0");
                        whereClauses.push("1 = 0");
                    }
                }
            } catch (err) {
                log(`!!! Błąd pobierania ustawień: ${err.message}`);
            }
        } 
        else if (isSD && quickFilter === 'open') {
            whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
        }
        else if (isSD && quickFilter === 'closed') {
            whereClauses.push("(c.status = 'Zamknięte' OR c.status = 'Rozwiązane' OR c.status = 'Odrzucone')");
        }

        // --- SQL ---
        // Budujemy proste zapytanie bez szukania tekstowego, żeby wyizolować błąd
        const whereString = " WHERE " + whereClauses.join(" AND ");
        
        // WPISUJEMY OFFSET/LIMIT BEZPOŚREDNIO
        finalQuery = `SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c ${whereString} ORDER BY c.dates.createdAt DESC OFFSET ${offset} LIMIT 10`;
        finalParameters = parameters;

        log(`5. Wykonuję zapytanie główne...`);
        
        // UWAGA: enableCrossPartitionQuery jest KLUCZOWE przy ORDER BY
        const { resources } = await container.items.query(
            { query: finalQuery, parameters: finalParameters },
            { enableCrossPartitionQuery: true }
        ).fetchAll();

        log(`6. Sukces! Pobranno ${resources.length} rekordów.`);

        context.res = {
            body: {
                debugLog,
                finalQuery,
                finalParameters,
                tickets: resources,
                totalCount: 100, // Fake count dla testu
                currentPage: 1,
                totalPages: 10
            }
        };

    } catch (error) {
        // ZWRACAMY 500 ALE Z JSONEM DIAGNOSTYCZNYM
        context.res = {
            status: 500,
            body: {
                message: "Internal Debug Error",
                errorDetails: error.message,
                cosmosActivityId: error.activityId, // Ważne dla Cosmos DB
                debugLog: debugLog,
                finalQuery: finalQuery,
                finalParameters: finalParameters
            }
        };
    }
};