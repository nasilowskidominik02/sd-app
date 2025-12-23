const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require('uuid');

/**
 * Obsługuje przesyłanie plików (załączników) do magazynu Azure Blob Storage.
 * * Funkcja działa w modelu "serverless upload":
 * 1. Odbiera plik zakodowany w Base64 w ciele żądania.
 * 2. Dekoduje go do binarnego bufora.
 * 3. Waliduje rozmiar (Soft Limit 50MB) przed wysłaniem do chmury, aby oszczędzać transfer i miejsce.
 * 4. Zapisuje plik w kontenerze 'attachments' z unikalną nazwą (UUID).
 *
 * @param {Object} context - Kontekst wykonania funkcji Azure (logowanie, odpowiedź).
 * @param {Object} req - Obiekt żądania HTTP.
 * @param {string} req.body.fileName - Oryginalna nazwa pliku (np. "error.png").
 * @param {string} req.body.fileContent - Zawartość pliku zakodowana jako Data URL (Base64).
 * @returns {Object} Odpowiedź HTTP:
 * - 200 OK: Zwraca publiczny URL do zapisanego pliku.
 * - 401 Unauthorized: Brak sesji użytkownika.
 * - 413 Payload Too Large: Przekroczono limit rozmiaru pliku (50MB).
 * - 500 Internal Server Error: Błąd konfiguracji (brak Connection String) lub błąd zapisu.
 */
module.exports = async function (context, req) {
    // Limit wielkości pliku ustalony na 50 MB.
    // Azure Functions (Node.js) mają limity pamięci sterty (heap limit). 
    // Przetwarzanie większych buforów w pamięci RAM może spowodować błąd "Out of Memory".
    const MAX_SIZE_BYTES = 50 * 1024 * 1024;

    const header = req.headers["x-ms-client-principal"];
    if (!header) {
        return { status: 401, body: { message: "Brak uwierzytelnienia." } };
    }

    try {
        const { fileName, fileContent } = req.body;

        if (!fileName || !fileContent) {
            return { status: 400, body: { message: "Nieprawidłowe dane pliku." } };
        }

        // Dekodowanie pliku z formatu Base64 (Data URL).
        // Frontend wysyła format: "data:image/png;base64,iVBORw0KGgo..."
        // Musimy usunąć prefiks metadanych, aby uzyskać czysty strumień bajtów.
        const base64Data = fileContent.split(';base64,').pop();
        const fileBuffer = Buffer.from(base64Data, 'base64');
        
        // Walidacja rozmiaru po zdekodowaniu.
        // Wykonujemy to przed nawiązaniem połączenia z Blob Storage, aby nie obciążać sieci
        // przesyłaniem plików, które i tak zostaną odrzucone.
        if (fileBuffer.length > MAX_SIZE_BYTES) {
             return { 
                status: 413, // HTTP 413: Payload Too Large
                body: { message: `Plik jest za duży. Limit wynosi 50MB. Twój plik: ${(fileBuffer.length / (1024 * 1024)).toFixed(2)} MB` } 
            };
        }

        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error("Brak skonfigurowanego klucza do Azure Storage (AZURE_STORAGE_CONNECTION_STRING).");
        }

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerName = "attachments";
        const containerClient = blobServiceClient.getContainerClient(containerName);
        
        // Zapewnienie istnienia kontenera z publicznym dostępem do blobów,
        // co pozwala na bezpośrednie linkowanie do załączników w przeglądarce.
        await containerClient.createIfNotExists({ access: 'blob' });

        // Generowanie bezpiecznej nazwy pliku.
        // Użycie UUID zapobiega kolizjom nazw (nadpisaniu pliku), gdy dwóch użytkowników
        // prześle plik o nazwie "screenshot.png".
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