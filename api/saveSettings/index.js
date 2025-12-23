const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
// Ustawienia są przechowywane w tym samym kontenerze co zgłoszenia ('Tickets'),
// ale wyróżniają się stałym ID 'global_settings'.
const container = client.database("ServiceDeskDB").container("Tickets");

/**
 * Aktualizuje globalną konfigurację aplikacji (Singleton Configuration).
 * * Endpoint ten zarządza centralnym dokumentem ustawień, który definiuje:
 * - Kategorie zgłoszeń i przypisane do nich grupy wsparcia.
 * - Czasy SLA (Service Level Agreement).
 * - Kalendarz pracy i dni wolne.
 * * Ze względu na krytyczny wpływ tych ustawień na działanie całego systemu (np. obliczanie terminów),
 * dostęp jest ściśle ograniczony do roli 'sd' (Service Desk / Administratorzy).
 * * Funkcja wymusza, aby zapisywany obiekt posiadał `id: 'global_settings'`,
 * co zapobiega przypadkowemu nadpisaniu innych dokumentów (np. zgłoszeń użytkowników) w tym samym kontenerze.
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure.
 * @param {Object} req - Obiekt żądania HTTP.
 * @param {Object} req.body - Kompletny obiekt konfiguracji JSON.
 * @returns {Object} Odpowiedź HTTP:
 * - 200 OK: Operacja udana, zwraca zaktualizowany obiekt.
 * - 400 Bad Request: Próba zapisu obiektu z nieprawidłowym ID (ochrona integralności danych).
 * - 401 Unauthorized: Brak sesji użytkownika.
 * - 403 Forbidden: Użytkownik zalogowany, ale brak roli 'sd'.
 * - 500 Internal Server Error: Błąd zapisu w bazie danych.
 */
module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: { message: "Nie jesteś zalogowany." } };
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    if (!clientPrincipal.userRoles.includes('sd')) {
        return { status: 403, body: { message: "Brak uprawnień administratora." } };
    }

    const newSettings = req.body;

    // Walidacja ID jest kluczowa w modelu Single-Container.
    // Zapobiega sytuacji, w której błąd frontendu mógłby nadpisać zgłoszenie o ID np. "2024-001".
    if (!newSettings || newSettings.id !== 'global_settings') {
        return { status: 400, body: { message: "Nieprawidłowe dane konfiguracyjne. Wymagane ID: 'global_settings'." } };
    }

    try {
        // Używamy upsert (Update or Insert), co pozwala na atomową aktualizację
        // całej konfiguracji bez konieczności wcześniejszego sprawdzania czy dokument istnieje.
        const { resource: updatedItem } = await container.items.upsert(newSettings);

        context.res = {
            status: 200,
            body: updatedItem
        };
    } catch (error) {
        context.log.error("Błąd w saveSettings:", error);
        context.res = {
            status: 500,
            body: { message: "Wystąpił błąd podczas zapisywania ustawień." }
        };
    }
};