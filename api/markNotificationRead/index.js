const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

/**
 * Zmienia status pojedynczego powiadomienia na "przeczytane".
 * * Funkcja jest wywoływana asynchronicznie przez frontend (np. po kliknięciu w dymek powiadomienia).
 * * Architektura Cosmos DB wymaga podania `partitionKey` przy operacjach na konkretnym dokumencie (Point Operation).
 * Pozwala to silnikowi bazy danych na natychmiastowe zlokalizowanie rekordu w odpowiednim sharcie fizycznym,
 * bez konieczności kosztownego skanowania całej bazy (Cross-Partition Query).
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure (logi, wyjście).
 * @param {Object} req - Obiekt żądania HTTP.
 * @param {string} req.body.id - Unikalne ID powiadomienia.
 * @param {string} req.body.partitionKey - Wartość klucza partycji (zazwyczaj e-mail odbiorcy), niezbędna do precyzyjnego zapisu.
 * @returns {Object} Odpowiedź HTTP:
 * - 200 OK: Operacja zakończona sukcesem.
 * - 400 Bad Request: Brak ID lub klucza partycji w żądaniu.
 * - 401 Unauthorized: Użytkownik nie jest zalogowany.
 * - 404 Not Found: Dokument nie istnieje.
 * - 500 Internal Server Error: Błąd zapisu w bazie danych.
 */
module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) return { status: 401, body: "Unauthorized" };
    
    const { id, partitionKey } = req.body;
    
    if (!id || !partitionKey) {
        context.log("Błąd markNotificationRead: Brak ID lub PartitionKey");
        return { status: 400, body: "Missing ID or PartitionKey" };
    }

    try {
        // Pobranie dokumentu przy użyciu operacji punktowej (najszybszy i najtańszy typ odczytu w Cosmos DB).
        const { resource: notification } = await container.item(id, partitionKey).read();

        if (notification && notification.type === 'notification') {
            notification.isRead = true;
            
            // Upsert nadpisuje dokument nową wersją (z flagą isRead=true).
            // Jest to bezpieczne tutaj, ponieważ edytujemy tylko flagę stanu, a nie dane biznesowe.
            await container.items.upsert(notification);
            
            context.res = { status: 200, body: "OK" };
        } else {
            context.res = { status: 404, body: "Notification not found" };
        }
    } catch (error) {
        context.log.error("Błąd markNotificationRead:", error);
        context.res = { status: 500, body: "Error" };
    }
};