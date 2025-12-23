const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

/**
 * Generuje raporty analityczne na podstawie zgłoszeń w zadanym okresie czasu.
 * * Funkcja realizuje podejście "Fetch-then-Aggregate":
 * 1. Pobiera surowe dane zgłoszeń z bazy Cosmos DB pasujące do zakresu dat.
 * 2. Przetwarza dane w pamięci aplikacji (JavaScript), co pozwala na elastyczne 
 * grupowanie i skomplikowane obliczenia dat (SLA) bez obciążania silnika bazy danych skomplikowanymi zapytaniami GROUP BY.
 * * Obliczane wskaźniki (KPI):
 * - Ilość zgłoszeń: Całkowity wolumen w danej grupie.
 * - Średni czas realizacji: Czas od utworzenia do zamknięcia (tylko dla zamkniętych).
 * - Naruszenie SLA (%): Procent zgłoszeń, które przekroczyły termin gwarantowany (dla otwartych sprawdza względem "teraz").
 *
 * @param {Object} context - Kontekst wykonania Azure Function.
 * @param {Object} req - Obiekt żądania HTTP.
 * @param {string} req.body.startDate - Początek zakresu raportu (ISO Date String).
 * @param {string} req.body.endDate - Koniec zakresu raportu (ISO Date String).
 * @param {string} req.body.reportType - Typ grupowania danych: 'user' | 'group' | 'specialist' | 'category'.
 * * @returns {Object} Odpowiedź HTTP zawierająca tablicę zagregowanych danych posortowaną malejąco według ilości zgłoszeń.
 * @throws {401/403} W przypadku braku autoryzacji lub odpowiedniej roli ('sd').
 */
module.exports = async function (context, req) {
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
        // Pobranie surowych danych.
        // Filtrujemy tylko po dacie i typie dokumentu, aby zminimalizować koszt RU (Request Units).
        // Wykluczamy powiadomienia i ustawienia globalne.
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

        const reportData = {};

        tickets.forEach(ticket => {
            // Dynamiczne ustalenie klucza grupowania na podstawie żądanego typu raportu
            let key = "Nieznane";
            if (reportType === 'user') key = ticket.reportingUser.name || ticket.reportingUser.email;
            else if (reportType === 'group') key = ticket.assignedTo.group;
            else if (reportType === 'specialist') key = ticket.assignedTo.person || "Nieprzypisane";
            else if (reportType === 'category') key = ticket.category;

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

            // Weryfikacja dotrzymania terminu SLA.
            // Logika różni się dla zgłoszeń zamkniętych i otwartych:
            // - Zamknięte: Porównujemy datę faktycznego zamknięcia z terminem SLA.
            // - Otwarte: Porównujemy obecną chwilę z terminem SLA (czy już jest po terminie?).
            const slaDate = new Date(ticket.dates.guaranteedResolutionAt);
            const isClosed = ticket.dates.closedAt ? true : false;
            
            let isOverdue = false;
            if (isClosed) {
                if (new Date(ticket.dates.closedAt) > slaDate) isOverdue = true;
            } else {
                if (new Date() > slaDate) isOverdue = true;
            }

            if (isOverdue) group.overdueTickets++;

            // Agregacja czasu realizacji (tylko dla zgłoszeń, które zostały już zamknięte)
            if (isClosed) {
                group.closedTickets++;
                const created = new Date(ticket.dates.createdAt);
                const closed = new Date(ticket.dates.closedAt);
                const diff = closed - created; // różnica w milisekundach
                group.totalResolutionTimeMs += diff;
            }
        });

        // Przekształcenie mapy na tablicę wyników i obliczenie średnich
        const results = Object.values(reportData).map(group => {
            const avgTimeMs = group.closedTickets > 0 ? (group.totalResolutionTimeMs / group.closedTickets) : 0;
            const avgTimeHours = (avgTimeMs / (1000 * 60 * 60)).toFixed(2); // Konwersja ms -> godziny
            const slaPercent = group.totalTickets > 0 ? ((group.overdueTickets / group.totalTickets) * 100).toFixed(1) : 0;

            return {
                name: group.key,
                count: group.totalTickets,
                avgTime: avgTimeHours,
                slaBreachPercent: slaPercent
            };
        });

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