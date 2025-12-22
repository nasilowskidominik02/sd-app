const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: "User is not authenticated." };
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    const isServiceDesk = clientPrincipal.userRoles.includes('sd');
    const userEmail = clientPrincipal.userDetails;
    
    const page = parseInt(req.query.page) || 1;
    const searchText = req.query.search ? req.query.search.toLowerCase().trim() : '';
    const searchField = req.query.field || 'id';
    
    // Domyślnie 'my_group' dla SD, 'all' dla reszty
    const quickFilter = req.query.quickFilter || (isServiceDesk ? 'my_group' : 'all');

    const pageSize = 10;
    const offset = (page - 1) * pageSize;

    let query = "SELECT c.id, c.status, c.title, c.reportingUser, c.category, c.assignedTo, c.dates FROM c";
    let countQuery = "SELECT VALUE COUNT(1) FROM c";
    let whereClauses = [];
    let parameters = [];

    // --- FILTRY PODSTAWOWE ---
    whereClauses.push("c.id != 'global_settings'");
    whereClauses.push("(NOT IS_DEFINED(c.type) OR c.type != 'notification')");

    // Jeśli to zwykły user, ZAWSZE widzi tylko swoje (niezależnie od filtra)
    if (!isServiceDesk) {
        whereClauses.push("c.reportingUser.email = @userEmail");
        parameters.push({ name: "@userEmail", value: userEmail });
    }

    // --- OBSŁUGA SZYBKIEGO FILTRA (DLA SD) ---
    if (isServiceDesk) {
        if (quickFilter === 'my_group') {
            try {
                // Pobieramy ustawienia
                const settingsQuerySpec = { 
                    query: "SELECT * FROM c WHERE c.id = 'global_settings'" 
                };
                const { resources: settings } = await container.items.query(settingsQuerySpec).fetchAll();
                
                let myGroupName = null;

                // --- ZABEZPIECZENIE PRZED BŁĘDEM 500 ---
                // Sprawdzamy czy settings[0] istnieje ORAZ czy ma właściwość groups ORAZ czy groups to tablica
                if (settings.length > 0 && settings[0].groups && Array.isArray(settings[0].groups)) {
                    
                    const userEmailLower = userEmail.toLowerCase();
                    
                    // Szukamy grupy bezpiecznie (sprawdzamy czy g.members istnieje)
                    const groupObj = settings[0].groups.find(g => 
                        g.members && Array.isArray(g.members) && g.members.includes(userEmailLower)
                    );
                    
                    if (groupObj) {
                        myGroupName = groupObj.name;
                    }
                }

                if (myGroupName) {
                    whereClauses.push("c.assignedTo.group = @myGroup");
                    parameters.push({ name: "@myGroup", value: myGroupName });
                } else {
                    // Jeśli nie znaleziono grupy (użytkownik nie jest przypisany lub brak ustawień),
                    // dodajemy warunek, który zawsze zwróci fałsz (brak wyników), 
                    // zamiast pokazywać wszystkie zgłoszenia (co mogłoby być mylące).
                    whereClauses.push("1 = 0"); 
                }
            } catch (err) {
                context.log.error("Błąd logiczny przy filtrze my_group:", err);
                // W razie błędu też nie pokazujemy nic, żeby nie wywalić 500 na frontend
                whereClauses.push("1 = 0");
            }
        } 
        else if (quickFilter === 'open') {
            whereClauses.push("c.status != 'Zamknięte' AND c.status != 'Rozwiązane' AND c.status != 'Odrzucone'");
        }
        else if (quickFilter === 'closed') {
            whereClauses.push("(c.status = 'Zamknięte' OR c.status = 'Rozwiązane' OR c.status = 'Odrzucone')");
        }
        // 'all' - nie dodajemy warunku
    }

    // --- WYSZUKIWANIE TEKSTOWE ---
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
        parameters.push({ name: "@searchRaw", value: req.query.search.trim() });
    }

    if (whereClauses.length > 0) {
        const whereString = " WHERE " + whereClauses.join(" AND ");
        query += whereString;
        countQuery += whereString;
    }
    
    query += " ORDER BY c.dates.createdAt DESC OFFSET @offset LIMIT @limit";
    parameters.push({ name: "@offset", value: offset });
    parameters.push({ name: "@limit", value: pageSize });

    const querySpec = { query, parameters };
    const countParams = parameters.filter(p => p.name !== '@offset' && p.name !== '@limit');
    
    try {
        const [countResponse, itemsResponse] = await Promise.all([
            container.items.query({ query: countQuery, parameters: countParams }).fetchAll(),
            container.items.query(querySpec).fetchAll()
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
        context.log.error("Cosmos DB Error:", error);
        context.res = { status: 500, body: "Error connecting to DB" };
    }
};