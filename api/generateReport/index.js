const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    // 1. Autoryzacja (Tylko SD)
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: "Unauthorized" };
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);
    if (!clientPrincipal.userRoles.includes('sd')) {
        return { status: 403, body: "Access denied" };
    }

    const { startDate, endDate, reportType } = req.body;

    try {
        // 2. Pobieranie zgłoszeń z zakresu dat (po dacie utworzenia)
        // Pobieramy wszystko z tego okresu, agregację zrobimy w JS (łatwiej o skomplikowane obliczenia)
        const querySpec = {
            query: `
                SELECT * FROM c 
                WHERE c.dates.createdAt >= @startDate 
                AND c.dates.createdAt <= @endDate
                AND c.id != 'global_settings'
                AND (NOT IS_DEFINED(c.type) OR c.type != 'notification')
            `,
            parameters: [
                { name: "@startDate", value: startDate },
                { name: "@endDate", value: endDate }
            ]
        };

        const { resources: tickets } = await container.items.query(querySpec).fetchAll();

        // 3. Agregacja Danych
        const reportData = {};

        tickets.forEach(ticket => {
            // Ustalanie klucza grupowania
            let key = "Nieznane";
            if (reportType === 'user') key = ticket.reportingUser.name || ticket.reportingUser.email;
            else if (reportType === 'group') key = ticket.assignedTo.group;
            else if (reportType === 'specialist') key = ticket.assignedTo.person || "Nieprzypisane";
            else if (reportType === 'category') key = ticket.category;

            // Inicjalizacja grupy
            if (!reportData[key]) {
                reportData[key] = {
                    key: key,
                    totalTickets: 0,
                    closedTickets: 0,
                    totalResolutionTimeMs: 0,
                    overdueTickets: 0
                };
            }

            const group = reportData[key];
            group.totalTickets++;

            // Sprawdzanie SLA (Przeterminowane)
            // Jeśli zamknięte: sprawdzamy czy closedAt > guaranteed
            // Jeśli otwarte: sprawdzamy czy teraz > guaranteed
            const slaDate = new Date(ticket.dates.guaranteedResolutionAt);
            const isClosed = ticket.dates.closedAt ? true : false;
            
            let isOverdue = false;
            if (isClosed) {
                if (new Date(ticket.dates.closedAt) > slaDate) isOverdue = true;
            } else {
                if (new Date() > slaDate) isOverdue = true;
            }

            if (isOverdue) group.overdueTickets++;

            // Czas realizacji (tylko dla zamkniętych)
            if (isClosed) {
                group.closedTickets++;
                const created = new Date(ticket.dates.createdAt);
                const closed = new Date(ticket.dates.closedAt);
                const diff = closed - created; // czas w ms
                group.totalResolutionTimeMs += diff;
            }
        });

        // 4. Formatowanie wyników (średnie)
        const results = Object.values(reportData).map(group => {
            const avgTimeMs = group.closedTickets > 0 ? (group.totalResolutionTimeMs / group.closedTickets) : 0;
            const avgTimeHours = (avgTimeMs / (1000 * 60 * 60)).toFixed(2); // Godziny
            const slaPercent = group.totalTickets > 0 ? ((group.overdueTickets / group.totalTickets) * 100).toFixed(1) : 0;

            return {
                name: group.key,
                count: group.totalTickets,
                avgTime: avgTimeHours, // W godzinach
                slaBreachPercent: slaPercent
            };
        });

        // Sortowanie po ilości zgłoszeń (malejąco)
        results.sort((a, b) => b.count - a.count);

        context.res = {
            status: 200,
            body: results
        };

    } catch (error) {
        context.log.error(error);
        context.res = { status: 500, body: "Błąd generowania raportu" };
    }
};