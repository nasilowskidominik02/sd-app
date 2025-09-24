const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require('uuid');
const multiparty = require('multiparty');

module.exports = async function (context, req) {
    // Sprawdzenie, czy użytkownik jest zalogowany
    const header = req.headers["x-ms-client-principal"];
    if (!header) {
        return { status: 401, body: { message: "Brak uwierzytelnienia." }};
    }

    try {
        const { fields, files } = await new Promise((resolve, reject) => {
            const form = new multiparty.Form();
            form.parse(req, (err, fields, files) => {
                if (err) reject(err);
                else resolve({ fields, files });
            });
        });

        if (!files.file || files.file.length === 0) {
            return { status: 400, body: { message: "Nie znaleziono pliku do przesłania." }};
        }

        const file = files.file[0];
        const fileBuffer = require('fs').readFileSync(file.path);

        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error("Brak skonfigurowanego klucza do Azure Storage.");
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerName = "attachments"; // Nazwa kontenera na załączniki
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists({ access: 'blob' }); // Ustawia publiczny dostęp do odczytu

        const blobName = `${uuidv4()}-${file.originalFilename}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.upload(fileBuffer, fileBuffer.length);

        context.res = {
            status: 200,
            body: { 
                message: "Plik został pomyślnie przesłany.",
                fileName: file.originalFilename,
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
