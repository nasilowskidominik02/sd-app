const { CosmosClient } = require("@azure/cosmos");

const client = new CosmosClient(process.env.COSMOS_DB_CONNECTION_STRING);
const container = client.database("ServiceDeskDB").container("Tickets");

module.exports = async function (context, req) {
    const header = req.headers['x-ms-client-principal'];
    if (!header) {
        return { status: 401, body: [] };
    }
    
    const encoded = Buffer.from(header, 'base64');
    const decoded = encoded.toString('ascii');
    const clientPrincipal = JSON.parse(decoded);
    const userEmail = clientPrincipal.userDetails;

    try {
        // POPRAWKA:
        // 1. Zamieniamy email zalogowanego usera na małe litery (bo tak zapisaliśmy w category)
        const userEmailLower = userEmail.toLowerCase();

        context.log(`Pobieram powiadomienia dla Partycji (category): ${userEmailLower}`);

        // 2. Zapytanie celuje w c.category (Partition Key)
        // To jest wydajniejsze i gwarantuje znalezienie dokumentu zapisanego w poprzednim kroku
        const querySpec = {
            query: "SELECT * FROM c WHERE c.type = 'notification' AND c.category = @userEmailLower AND c.isRead = false",
            parameters: [{ name: "@userEmailLower", value: userEmailLower }]
        };

        const { resources: notifications } = await container.items.query(querySpec).fetchAll();
        
        // Sortowanie po stronie JS (bezpieczniejsze przy różnych typach danych)
        notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        context.res = {
            status: 200,
            body: notifications
        };
    } catch (error) {
        context.log.error("Błąd w getNotifications:", error);
        context.res = { status: 500, body: [] };
    }
};