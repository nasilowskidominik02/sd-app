{
  // DOKUMENTACJA: Konfiguracja Azure Static Web Apps
  // Cel: Kontrola ruchu sieciowego, zarządzanie rolami (RBAC) oraz obsługa błędów HTTP
  // na poziomie serwera proxy Azure, zanim żądanie trafi do plików statycznych.

  "routes": [
    // --- OGRANICZENIA DOSTĘPU (RBAC) ---
    // Zasada działania: Azure SWA sprawdza te reguły od góry do dołu.
    // Jeśli użytkownik nie posiada wymaganej roli, serwer zwróci błąd 401 (niezalogowany)
    // lub 403 (brak uprawnień), co następnie zostanie przechwycone przez 'responseOverrides'.

    {
      // Panel główny dostępny dla wszystkich zalogowanych użytkowników.
      // 'user' - standardowa rola nadawana po zalogowaniu.
      // 'sd' - rola administratora/serwisu (również ma dostęp).
      "route": "/dashboard.html",
      "allowedRoles": ["user", "sd"]
    },
    {
      // Panel administracyjny.
      // Dostęp ściśle ograniczony tylko dla roli 'sd' (Service Desk).
      // Próba wejścia przez zwykłego 'user' spowoduje błąd 403.
      "route": "/admin.html",
      "allowedRoles": ["sd"]
    },
    {
      // Centrum raportowania.
      // Dostęp tylko dla roli 'sd' ze względu na widoczność danych wrażliwych/statystycznych.
      "route": "/reports.html",
      "allowedRoles": ["sd"]
    }
  ],

  "responseOverrides": {
    // --- OBSŁUGA BŁĘDÓW UWIERZYTELNIANIA ---
    // Zamiast pokazywać surowe strony błędów przeglądarki, przekierowujemy użytkownika
    // na odpowiednie strony aplikacji.

    "401": {
      // Sytuacja: Użytkownik anonimowy próbuje wejść na chronioną trasę (np. /dashboard.html).
      // Akcja: Przekierowanie na stronę logowania (index.html).
      // StatusCode 302 (Found) informuje przeglądarkę, że to tymczasowe przekierowanie.
      "redirect": "/index.html",
      "statusCode": 302
    },
    "403": {
      // Sytuacja: Użytkownik JEST zalogowany, ale nie ma odpowiedniej roli (np. 'user' wchodzi na /admin.html).
      // Akcja: Przekierowanie na stronę informującą o braku uprawnień.
      // Zapobiega to pętli przekierowań na stronę logowania.
      "redirect": "/unauthorized.html",
      "statusCode": 302
    }
  }
}