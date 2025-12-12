const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    // 1. Sprawdzenie autoryzacji
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: { message: "Nie jesteś zalogowany." } };
    }
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);

    // 2. Sprawdzenie roli 'sd' (Service Desk)
    if (!clientPrincipal.userRoles.includes('sd')) {
        return { status: 403, body: { message: "Brak uprawnień administratora." } };
    }

    const newSettings = req.body;

    // Walidacja podstawowa
    if (!newSettings || newSettings.id !== 'global_settings') {
        return { status: 400, body: { message: "Nieprawidłowe dane konfiguracyjne." } };
    }

    try {
        // Upsert (nadpisanie) dokumentu w bazie
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