const { CosmosClient } = require("@azure/cosmos");

// Pobieramy "klucz" do bazy danych z ustawień aplikacji w Azure
const connectionString = process.env.COSMOS_DB_CONNECTION_STRING;
const client = new CosmosClient(connectionString);

// Nazwy naszej bazy danych i kontenera (tabeli)
const databaseId = "ServiceDeskDB";
const containerId = "Tickets";

module.exports = async function (context, req) {
    try {
        // Łączymy się z odpowiednią bazą i kontenerem
        const database = client.database(databaseId);
        const container = database.container(containerId);

        // Pobieramy wszystkie dokumenty (zgłoszenia) z kontenera
        const { resources: tickets } = await container.items.readAll().fetchAll();

        // Odsyłamy pobrane dane jako odpowiedź w formacie JSON
        context.res = {
            status: 200,
            body: tickets
        };
    } catch (error) {
        // W przypadku błędu odsyłamy status 500 i informację o błędzie
        context.res = {
            status: 500,
            body: `Error connecting to or reading from database: ${error.message}`
        };
    }
};
