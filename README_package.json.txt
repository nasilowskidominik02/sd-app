{
  // DOKUMENTACJA: Manifest Projektu Node.js (Azure Functions)
  // Cel: Definiuje zależności biblioteczne, skrypty uruchomieniowe oraz wymagania środowiskowe
  // dla warstwy backendowej aplikacji Service Desk.

  "name": "sd-app-api",
  "version": "1.0.0",
  "description": "",

  "scripts": {
    // Uruchamia lokalny serwer deweloperski Azure Functions Core Tools.
    // Pozwala na testowanie i debugowanie funkcji API na komputerze programisty (localhost)
    // przed wdrożeniem ich do chmury.
    "start": "func start",
    "test": "echo \"No tests yet...\""
  },

  "dependencies": {
    // Klient SDK do bazy danych Azure Cosmos DB (NoSQL).
    // Jest to "serce" backendu - używane w prawie każdym endpoincie do zapisywania i odczytu zgłoszeń,
    // ustawień, liczników oraz powiadomień.
    "@azure/cosmos": "^3.17.3",

    // Klient SDK do usługi Azure Blob Storage.
    // Używany wyłącznie przez funkcję 'uploadAttachment' do bezpiecznego przesyłania
    // i przechowywania plików załączników w chmurze.
    "@azure/storage-blob": "^12.14.0",

    // Biblioteka do generowania unikalnych identyfikatorów (UUID v4).
    // Wykorzystywana do:
    // 1. Nadawania unikalnych nazw plikom w Blob Storage (uniknięcie nadpisywania plików o tej samej nazwie).
    // 2. Generowania ID dla nowych powiadomień systemowych.
    "uuid": "^9.0.0"
  },

  "devDependencies": {},

  "engines": {
    // Definiuje wymaganą wersję środowiska uruchomieniowego Node.js.
    // Jest to kluczowe dla Azure Static Web Apps, aby wiedziało, jakiego kontenera użyć do budowania i uruchamiania API.
    // Wersja >=14.0.0 zapewnia wsparcie dla nowoczesnych funkcji JS (np. async/await, optional chaining).
    "node": ">=14.0.0"
  }
}