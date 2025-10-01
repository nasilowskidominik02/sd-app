const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require('uuid');

module.exports = async function (context, req) {
    // Sprawdzenie, czy użytkownik jest zalogowany
    const header = req.headers["x-ms-client-principal"];
    if (!header) {
        return { status: 401, body: { message: "Brak uwierzytelnienia." } };
    }

    try {
        const { fileName, fileContent } = req.body;

        if (!fileName || !fileContent) {
            return { status: 400, body: { message: "Nieprawidłowe dane pliku." } };
        }

        // Dekodowanie pliku z formatu Base64
        // Usuwamy nagłówek 'data:image/png;base64,' lub podobny
        const base64Data = fileContent.split(';base64,').pop();
        const fileBuffer = Buffer.from(base64Data, 'base64');
        
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error("Brak skonfigurowanego klucza do Azure Storage.");
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerName = "attachments";
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists({ access: 'blob' });

        const blobName = `${uuidv4()}-${fileName}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(fileBuffer, fileBuffer.length);

        context.res = {
            status: 200,
            body: { 
                message: "Plik został pomyślnie przesłany.",
                fileName: fileName,
                url: blockBlobClient.url
            }
        };

    } catch (error) {
        context.log.error("Błąd podczas przesyłania pliku:", error.message);
        context.res = {
            status: 500,
            body: { message: "Wystąpił błąd serwera podczas przesyłania pliku." }
        };
    }
};

