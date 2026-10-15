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
   - **Mitglieder**: anlegen, bearbeiten, Benutzername und Passwort setzen, aktiv/inaktiv, löschen;
     **„Dodaj više članova“**: Liste einfügen (pro Zeile „Vorname, Nachname“) – Benutzername und sicheres
     Zufallspasswort werden automatisch erzeugt und einmalig in einer Übersicht angezeigt (gespeichert wird nur der Hash);
     Stundenpreis und optionale monatliche Grundgebühr. Die **Abrechnungsart** wird **pro Mitglied und
     pro Monat** einzeln auf der Seite „Mjesečni iznos“ gewählt:
     - „Prema rasporedu“: Termine werden automatisch berechnet
     - „Raspored s prikazom, bez obračuna“: Termine werden in der Abrechnung angezeigt, aber nicht berechnet
     - „Ručni unos“: Termine erscheinen nicht, der Betrag wird nur manuell als Posten eingetragen
   - **Grupe**: feste Trainingsgruppen (z. B. „Grupa 1“ … „Grupa 10“) mit 2–8 Mitgliedern anlegen,
     bearbeiten, löschen. Beim Anlegen eines Termins wählt man die Gruppe aus und ihre Mitglieder
     bekommen automatisch ein Häkchen in der Spielerliste (einzelne Häkchen lassen sich wieder entfernen; Trainingsart wird auf Gruppentraining gesetzt).
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
   - **Finansije** (Prihodi i rashodi): pro Monat Einnahmen (automatisch: bezahlte Mitgliederbeträge;
     manuell: Turniergewinn, Camps, Sponsoren, Platzvermietung, Verkauf, Sonstiges) und Ausgaben
     (automatisch: Trainerauszahlungen; manuell: Platzmiete, Bälle, Strom, Wasser, Requisiten, Benzin,
     Platzpflege, Versicherung, Marketing, Verbandsgebühren, Buchhaltung, Investitionen, Sonstiges).
     Ergebnis (Gewinn/Verlust), Ausgaben nach Kategorien und Jahresübersicht.
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

**Abgeschlossene Monate:** Sobald ein Monat vorbei ist, wird seine Abrechnung automatisch abgeschlossen und
gespeichert (Abrechnungsart, Grundgebühr, Termine, Posten, Betrag). Spätere Änderungen an Preisen, Grundgebühr,
Terminen oder anderen Monaten verändern ihn nicht mehr; der Admin sieht nur einen Hinweis, falls sich der
Plan seither geändert hat. Will der Admin einen vergangenen Monat bewusst ändern, klickt er auf
„Retroaktivno izmijeni ovaj mjesec“, nimmt die Änderungen vor und schließt den Monat mit „Zaključaj mjesec ponovo“
wieder ab. Bestehende Daten: Beim ersten Start nach dem Update werden alle vergangenen Monate genau so
abgeschlossen, wie sie bis dahin berechnet wurden; laufende und künftige Monate übernehmen die bisherige
Abrechnungsart des Mitglieds, bis man sie für einen Monat ändert.

## Starten

Voraussetzung: Node.js ≥ 22.13 (nutzt das eingebaute `node:sqlite`, keine nativen Abhängigkeiten).

```bash
npm install
npm start            # http://localhost:3000
```

**Fester Admin-Account (empfohlen):** Kopiere `.env.example` nach `.env` und trage `ADMIN_EMAIL` und
`ADMIN_PASSWORD` ein. Die Datei `.env` wird nicht auf GitHub hochgeladen. Bei jedem Start wird dieser
Account angelegt bzw. auf genau diese Zugangsdaten gesetzt – sie ändern sich also nie von selbst.
Auf einem Hosting-Dienst (z. B. Railway) trägt man dieselben Werte als „Variables“ ein.

Ohne diese Einstellung gilt: Beim ersten Start wird ein Admin-Konto angelegt und die Zugangsdaten werden in der Konsole
ausgegeben. Alternativ vorher festlegen:

```bash
ADMIN_EMAIL=chef@meine-tennisschule.de ADMIN_PASSWORD='ein-sicheres-passwort' npm start
```

Beispieldaten zum Ausprobieren (3 Mitglieder mit Terminen, 2 Interessenten; Benutzernamen `amina`,
`emir`, `lejla`, Passwort `tennis123`; Trainer `haris`, `ivana`, Passwort `trener123`):

```bash
npm run demo
```

Tests: `npm test`

## Anmeldung

- **Mitglieder und Trainer** melden sich mit **Benutzername** („Korisničko ime“) und Passwort an.
  Der Benutzername wird vom Admin beim Anlegen vergeben, ist eindeutig (über Mitglieder und Trainer
  hinweg, Groß-/Kleinschreibung egal) und besteht aus 3–40 Zeichen: a–z, 0–9, Punkt, Bindestrich, Unterstrich.
- **Admin** meldet sich im selben Formular wie bisher mit seiner **E-Mail-Adresse** an.
- Bestehende Mitglieder und Trainer aus der Zeit der E-Mail-Anmeldung bekommen beim ersten Start
  automatisch einen Benutzernamen (aus dem Teil der E-Mail vor dem „@“, bei Trainern ohne E-Mail aus dem
  Namen; bei Doppelungen mit Zahl, z. B. `amra2`). Der Admin sieht ihn in der Mitgliederliste bzw. beim
  Trainer und kann ihn jederzeit ändern. Sonst bleiben alle Daten unverändert.

## Wochenfreigabe (Trainingsplan)

- Jede Woche (Mo–So) ist entweder **versteckt** oder **freigegeben**. Mitglieder und Kinder-Konten sehen Termine
  einer Woche nur, wenn sie freigegeben ist – auch nicht in „Sljedeći termini“ oder als einzelne Zeilen in der
  Abrechnung. Der Admin sieht immer alles; Trainer sehen ihren Plan wie bisher.
- **Automatisch:** am Sonntag vor der Woche um **17:00 Uhr Sarajevo-Zeit** (Sommer-/Winterzeit wird berücksichtigt).
- Unter **Termini** zeigt ein Panel den Status der Woche mit den Knöpfen „Objavi sedmicu sada“ (manuell freigeben),
  „Sakrij ponovo“ und „Isključi / Uključi automatsku objavu“ (nur für diese eine Woche).
- Bestehende Daten: vergangene und die laufende Woche sind sofort freigegeben (ihr Sonntag 17 Uhr ist vorbei),
  künftige Wochen erscheinen ab ihrem Sonntag 17 Uhr oder nach manueller Freigabe.

## Kinder-Konten

- Ein Mitglied (Elternteil) legt unter **„Djeca“** für jedes Kind einen eigenen Zugang an (Name, Benutzername,
  Passwort), kann das Passwort neu setzen und das Konto löschen. Es sieht und verwaltet nur seine eigenen Kinder.
  Pro Mitglied ist **genau ein Kinder-Konto** möglich – fest für alle, auch der Admin kann das nicht erhöhen.
  Ist bereits ein Kinder-Konto vorhanden, erscheint statt des Formulars ein Hinweis.
- Ein Kind meldet sich mit seinem Benutzernamen an und sieht **nur seinen eigenen Wochenplan** (Wochen, Termine,
  Trainings). Beträge, Zahlungen, Abrechnung, Aktuelnosti und Einstellungen sind für Kinder gesperrt.
- Im Admin-Bereich erscheinen Kinder wie normale Mitglieder (Hinweis „dijete · roditelj: …“), damit man ihnen
  Termine und Gruppen zuordnen kann. Wird das Elternkonto gelöscht, werden auch seine Kinder-Konten gelöscht.

## Daten dauerhaft speichern (Railway)

Die Daten liegen in einer SQLite-Datei. Auf Railway ist das Dateisystem eines Dienstes **flüchtig**:
Bei jedem Deploy (also nach jedem Code-Update) startet ein neuer Container, und ohne Volume wäre die
Datenbank danach leer. Deshalb:

1. Im Railway-Projekt den Dienst anklicken → Rechtsklick/„+“ → **Volume** anlegen und an den Dienst hängen,
   Mount-Pfad **`/data`**.
2. Fertig – die App erkennt das Volume automatisch (`RAILWAY_VOLUME_MOUNT_PATH`) und speichert die Datenbank
   unter `/data/bettertennis.db`. Im Deploy-Log steht `Datenbank: /data/bettertennis.db`.
   Fehlt das Volume, erscheint im Log eine deutliche Warnung.

Zusätzlich kann der Admin auf der Übersichtsseite unter „Sigurnosna kopija“ jederzeit eine komplette
Sicherungskopie der Datenbank herunterladen.

Lokal gehen keine Daten verloren, solange der Ordner `data/` nicht gelöscht wird.

## Konfiguration

| Variable         | Bedeutung                                                         | Standard              |
|------------------|-------------------------------------------------------------------|-----------------------|
| `PORT`           | HTTP-Port                                                         | `3000`                |
| `DB_FILE`        | Pfad der SQLite-Datenbank                                         | Railway-Volume, sonst `data/bettertennis.db`|
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

Die vier Programmkarten (Individualni, Grupni, Video analiza, Konsultacije) zeigen Fotos von Unsplash
(Unsplash-Lizenz). Die Foto-IDs stehen in `src/routes/public.js` (`PROGRAMS`) und lassen sich dort austauschen.
Lädt ein Foto nicht, erscheint automatisch die eigene Illustration aus `public/img/illustracije/`. Die Startseite nutzt sanfte Scroll- und Hover-Animationen;
bei der Systemeinstellung „Bewegung reduzieren“ werden sie automatisch abgeschaltet.

Foto auf der Startseite: [Aleksandr Galichkin auf Unsplash](https://unsplash.com/photos/a-clay-tennis-court-with-lines-msx3rGYfOEc)
(Unsplash-Lizenz, kostenlos nutzbar, Namensnennung nicht erforderlich – daher auf der Seite ohne Bildnachweis).
Das Foto liegt lokal unter `public/img/tennisplatz.jpg` und erscheint daher auch ohne Internetverbindung.

Sicherheit: Passwörter mit scrypt gehasht, HMAC-signierte HttpOnly-Cookies, CSRF-Token auf allen
Formularen, Content-Security-Policy, Begrenzung fehlgeschlagener Logins, alle Ausgaben HTML-escaped.
