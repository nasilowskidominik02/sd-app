const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

/**
 * Pobiera szczegółowe dane pojedynczego zgłoszenia na podstawie jego ID.
 * * Kluczowy aspekt architektoniczny:
 * Funkcja wykonuje zapytanie `SELECT *`, co gwarantuje pobranie nie tylko danych biznesowych,
 * ale także metadanych systemowych Cosmos DB, w szczególności pola `_etag`.
 * * Frontend **musi** otrzymać aktualny `_etag`, aby przy późniejszej próbie edycji (w `updateTicket`)
 * móc skorzystać z mechanizmu Optimistic Concurrency Control (zapobieganie nadpisywaniu zmian innych użytkowników).
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure.
 * @param {Object} req - Obiekt żądania HTTP.
 * @param {string} req.query.id - Unikalny identyfikator zgłoszenia (np. "2025-0042").
 * @returns {Object} Odpowiedź HTTP:
 * - 200 OK: Pełny obiekt zgłoszenia wraz z metadanymi systemowymi.
 * - 400 Bad Request: Brak parametru ID w zapytaniu.
 * - 404 Not Found: Zgłoszenie o podanym ID nie istnieje.
 * - 500 Internal Server Error: Błąd komunikacji z bazą danych.
 */
module.exports = async function (context, req) {
    const ticketId = req.query.id;
    
    if (!ticketId) {
        context.res = { status: 400, body: "Please pass a ticket id on the query string" };
        return;
    }

    try {
        // Używamy zapytania SQL zamiast point-read, co pozwala na elastyczność,
        // ale kluczowe jest zachowanie pól systemowych (_etag) w wyniku.
        const querySpec = {
            query: "SELECT * FROM c WHERE c.id = @id",
            parameters: [{ name: "@id", value: ticketId }]
        };

        const { resources: items } = await container.items.query(querySpec).fetchAll();

        if (items.length === 0) {
            context.res = { status: 404, body: "Ticket not found" };
        } else {
            // Zwracamy surowy obiekt z bazy, dzięki czemu frontend otrzymuje wersję dokumentu (_etag)
            context.res = { body: items[0] };
        }
    } catch (error) {
        context.res = { status: 500, body: error.message };
    }
};