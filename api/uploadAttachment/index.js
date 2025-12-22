const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require('uuid');

module.exports = async function (context, req) {
    // Limit 50 MB (w bajtach)
    const MAX_SIZE_BYTES = 50 * 1024 * 1024;

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
        // Usuwamy ewentualny nagłówek 'data:image/png;base64,'
        const base64Data = fileContent.split(';base64,').pop();
        const fileBuffer = Buffer.from(base64Data, 'base64');
        
        // --- WALIDACJA ROZMIARU (NOWOŚĆ) ---
        if (fileBuffer.length > MAX_SIZE_BYTES) {
             return { 
                status: 413, // Payload Too Large
                body: { message: `Plik jest za duży. Limit wynosi 50MB. Twój plik: ${(fileBuffer.length / (1024 * 1024)).toFixed(2)} MB` } 
            };
        }
        // ------------------------------------

        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error("Brak skonfigurowanego klucza do Azure Storage (AZURE_STORAGE_CONNECTION_STRING).");
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerName = "attachments";
        const containerClient = blobServiceClient.getContainerClient(containerName);
        
        // Upewniamy się, że kontener istnieje
        await containerClient.createIfNotExists({ access: 'blob' });

        const blobName = `${uuidv4()}-${fileName}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        // Upload do Blob Storage
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