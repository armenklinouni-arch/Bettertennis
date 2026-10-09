# BetterTennis

Webanwendung für eine Tennisschule. **Die Oberfläche ist auf Bosnisch** (lateinische Schrift);
diese Anleitung ist auf Deutsch. Die Anwendung hat drei Bereiche:

1. **Startseite** – Interessenten tragen sich unverbindlich für Tennisstunden ein
   (Name, E-Mail, Telefon – Pflichtfeld –, Spielstärke, Wunschzeiten, Nachricht).
2. **Mitgliederbereich** (Login) – Wochenübersicht **Montag bis Sonntag** mit Name, Datum und
   Uhrzeit jeder gebuchten Trainingseinheit (Wochen vor/zurück blätterbar) sowie der
   **Monatsbetrag**, der am Monatsende fällig wird – nur zur Information, keine Bezahlfunktion.
3. **Admin-Bereich** – Verwaltung von allem:
   - **Interessenten**: Status pflegen (neu, kontaktiert, Probestunde, Mitglied, abgelehnt),
     mit einem Klick als Mitglied anlegen, löschen
   - **Mitglieder**: anlegen, bearbeiten, Passwort setzen, aktiv/inaktiv, löschen;
     Stundenpreis, optionale monatliche Grundgebühr und **Abrechnungsart**:
     - „Prema rasporedu“: Termine werden automatisch berechnet
     - „Raspored s prikazom, bez obračuna“: Termine werden in der Abrechnung angezeigt, aber nicht berechnet
     - „Ručni unos“: Termine erscheinen nicht, der Betrag wird nur manuell als Posten eingetragen
   - **Treneri**: Trainer anlegen/bearbeiten/löschen mit getrenntem Stundensatz für Einzel- und
     Gruppentraining; Monatsbericht pro Trainer (Anzahl, Stunden und Auszahlung getrennt nach
     Einzel/Gruppe, Zusatzzahlungen wie Prämien, Gesamtauszahlung, Wert der Trainings und Differenz)
     und Detailliste aller durchgeführten Trainings. Gruppentraining zählt einmal pro Termin.
   - **Termine**: Wochenplan aller Mitglieder, Termine anlegen (einmalig oder wöchentlich
     für 4–52 Wochen), bearbeiten, löschen
     - **Individualni trening** (1 Mitglied) oder **Grupni trening** (2–8 Mitglieder). Jedes
       Mitglied sieht im eigenen Plan nur sich selbst, nicht die anderen Gruppenmitglieder.
     - Jedem Termin kann ein **Trainer** zugeordnet werden (nur für den Admin sichtbar, Mitglieder sehen den Trainer nicht)
     - **Status**: neue Termine sind automatisch „Realizovan“; mit einem Klick auf „Otkazan“
       umstellbar (abgesagte Termine werden nicht berechnet)
   - **Beträge**: Monatsübersicht aller Mitglieder, Detailansicht pro Mitglied, Zusatzposten
     und Gutschriften (negative Beträge), **Freigabe pro Monat** („Odobri za člana“; vorher sieht das
     Mitglied nur „Obračun u pripremi“, Freigabe jederzeit rücknehmbar), Status **Plaćeno / Nije plaćeno** pro Monat
     (Mitglieder sehen den aktuellen Monat und 3 Monate zurück)
   - **Aktuelnosti**: Neuigkeiten (Turniere, Aktivitäten …) an alle oder ausgewählte Mitglieder
     schicken; Mitglieder sehen sie in ihrem Postfach mit Zähler für ungelesene Nachrichten
     (kein E-Mail-Versand)

4. **Trainerbereich** (Login unter `/login`, Zugang legt der Admin beim Trainer an) – jeder Trainer
   sieht nur seine eigenen Daten: Gesamtstunden seit dem ersten Training, Monatsbericht (Anzahl,
   Stunden und Betrag für Einzel- und Gruppentraining, Zusatzzahlungen), Liste der Trainings mit
   Anzahl und Namen der Spieler sowie seinen Wochenplan. Keine Daten anderer Trainer, keine
   Mitgliederpreise.

Monatsbetrag = Grundgebühr + Preise aller „Realizovan“-Termine des Monats + Zusatzposten
(bei manueller Abrechnung nur Grundgebühr + Zusatzposten). Der Terminpreis wird beim Anlegen aus dem
Stundenpreis berechnet und kann pro Termin überschrieben werden; bei Gruppentraining gilt er pro Person.
Alle Beträge in Konvertibler Mark (KM).

## Starten

Voraussetzung: Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`, keine nativen Abhängigkeiten).

```bash
npm install
npm start            # http://localhost:3000
```

Beim ersten Start wird ein Admin-Konto angelegt und die Zugangsdaten werden in der Konsole
ausgegeben. Alternativ vorher festlegen:

```bash
ADMIN_EMAIL=chef@meine-tennisschule.de ADMIN_PASSWORD='ein-sicheres-passwort' npm start
```

Beispieldaten zum Ausprobieren (3 Mitglieder mit Terminen, 2 Interessenten; Logins `amina@example.ba`,
`emir@example.ba`, `lejla@example.ba`, Passwort `tennis123`; Trainer `haris@example.ba`,
`ivana@example.ba`, Passwort `trener123`):

```bash
npm run demo
```

Tests: `npm test`

## Konfiguration

| Variable         | Bedeutung                                                         | Standard              |
|------------------|-------------------------------------------------------------------|-----------------------|
| `PORT`           | HTTP-Port                                                         | `3000`                |
| `DB_FILE`        | Pfad der SQLite-Datenbank                                         | `data/bettertennis.db`|
| `ADMIN_EMAIL`    | E-Mail des ersten Admins (nur wenn noch kein Admin existiert)     | `admin@bettertennis.local` |
| `ADMIN_PASSWORD` | Passwort des ersten Admins                                        | zufällig, wird geloggt |
| `SESSION_SECRET` | Schlüssel für Session-Cookies                                     | wird erzeugt und in der DB gespeichert |
| `NODE_ENV`       | `production` setzt Cookies auf `Secure` (HTTPS nötig)             | –                     |
| `TRUST_PROXY`    | `1`, wenn die App hinter einem Reverse-Proxy läuft                | –                     |
| `CURRENCY`       | Währung der Beträge, z. B. `BAM` (Konvertible Mark, „KM“) oder `EUR` | `BAM`              |
| `TZ`             | Zeitzone für „heute“ und Wochenbeginn                             | `Europe/Berlin`       |

## Aufbau

```
src/
  server.js        Startpunkt, Admin-Erstanlage
  app.js           Express-App, Sicherheits-Header, Middleware
  db.js            SQLite-Schema (users, lessons, adjustments, leads, settings)
  auth.js          Passwort-Hashing (scrypt), signierte Session-Cookies, CSRF, Login-Sperre
  billing.js       Berechnung des Monatsbetrags
  dates.js         Datums-/Wochenlogik (Montag–Sonntag, KW)
  money.js         Euro-Formatierung und -Eingabe (Beträge in Cent)
  views.js         Layout, Wochenansicht, Abrechnungstabelle
  routes/          public.js, member.js, admin.js
public/            CSS und ein kleines Script (Lösch-Bestätigung)
scripts/demo-daten.js
test/app.test.js
```

Foto auf der Startseite: [Aleksandr Galichkin auf Unsplash](https://unsplash.com/photos/a-clay-tennis-court-with-lines-msx3rGYfOEc)
(Unsplash-Lizenz, kostenlos nutzbar, Namensnennung nicht erforderlich – daher auf der Seite ohne Bildnachweis).
Es wird direkt von Unsplash geladen; ohne Internetverbindung erscheint stattdessen der gezeichnete Tennisplatz.

Sicherheit: Passwörter mit scrypt gehasht, HMAC-signierte HttpOnly-Cookies, CSRF-Token auf allen
Formularen, Content-Security-Policy, Begrenzung fehlgeschlagener Logins, alle Ausgaben HTML-escaped.
