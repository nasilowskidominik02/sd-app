const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require('uuid');

module.exports = async function (context, req) {
    // Sprawdzenie, czy użytkownik jest zalogowany
    const header = req.headers["x-ms-client-principal"];
    if (!header) {
        return { status: 401, body: { message: "Brak uwierzytelnienia." } };
    }

    try {
        // Nowoczesny sposób parsowania danych formularza w Azure Functions
        const formData = await req.formData();
        const file = formData.get('file');

        if (!file) {
            return { status: 400, body: { message: "Nie znaleziono pliku w formularzu." } };
        }
        
        // NOWA, PROSTSZA METODA: Konwersja pliku na ArrayBuffer
        const fileBuffer = await file.arrayBuffer();

        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error("Brak skonfigurowanego klucza do Azure Storage.");
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerName = "attachments"; // Nazwa kontenera na załączniki
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists({ access: 'blob' });

        const blobName = `${uuidv4()}-${file.name}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        // Przesłanie bufora (ArrayBuffer) do Blob Storage
        await blockBlobClient.upload(fileBuffer, fileBuffer.byteLength);

        context.res = {
            status: 200,
            body: { 
                message: "Plik został pomyślnie przesłany.",
                fileName: file.name,
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

