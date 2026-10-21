# Familien-App

Private App für zwei Personen: gemeinsamer Kalender und Einkaufsliste (Produktkatalog ohne Alkohol),
Live-Synchronisierung und Push-Benachrichtigungen. Läuft als installierbare Web-App (PWA) auf Android und iPhone.

- `index.html`, `app.js`, `styles.css`: die App
- `products.js`: Produktkatalog und Alkohol-Filter
- `sw.js`: Offline-Unterstützung und Benachrichtigungen
- `config.js`: Supabase-Adresse und öffentliche Schlüssel
- `supabase/schema.sql`: Datenbank und Zugriffsregeln (nur Mitglieder aus der Tabelle `members`)
- `supabase/functions/notify`: verschickt Push-Benachrichtigungen an den Partner

Der private VAPID-Schlüssel gehört nur in die Supabase-Secrets, nie in dieses Repository.
