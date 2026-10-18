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
     **„Dodaj više članova“**: Liste einfügen (pro Zeile „Vorname, Nachname“) – Benutzername und ein gut
     lesbares Zufallspasswort (Wort + 3 Ziffern, z. B. `Teren482`) werden automatisch erzeugt und einmalig in einer Übersicht angezeigt (gespeichert wird nur der Hash);
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

- Die öffentliche Startseite (Početna) ist **aktiv**: Wer bettertennis.net aufruft, sieht zuerst die Startseite
  und kommt über „Već sam član“ bzw. „Prijava za članove“ zum Login. Mit der Variable `PUBLIC_HOMEPAGE=0`
  (Railway → Variables) lässt sie sich ausschalten – dann führt „/“ direkt zum Login.

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

## Elternkonten (Roditelji)

- Übergeordnete Konto-Ebene, **nur lesen**. Der Admin legt sie unter **Roditelji** an (Name, Benutzername,
  Passwort) und wählt dabei ein oder mehrere bestehende Mitglieds-Konten als Spieler aus; Zuordnung,
  Passwort und Status lassen sich später ändern. Die Spieler bleiben normale Mitglieder mit eigenen
  Terminen und eigener Abrechnung.
- Login mit dem Elternkonto → **Sedmični raspored**: Trainingsplan aller zugeordneten Spieler gebündelt in
  einer Wochenansicht (nur freigegebene Wochen, ohne Trainer).
- **Finansije**: pro Monat (vor/zurück, auch künftige Monate) Liste der Spieler mit Betrag und Status.
  Per Häkchen wird frei gewählt, welche Spieler in die Summe einfließen; die Summe wird sofort neu berechnet.
  Die Auswahl wird **nicht gespeichert** (nur in der Adresse); ohne Auswahl sind alle Spieler einbezogen.
  Wie bei Mitgliedern zählt ein Monat erst, wenn der Admin ihn freigegeben hat („Obračun u pripremi“).
  Unter der Auswahl stehen für jeden ausgewählten Spieler die einzelnen Posten des Monats (Grundgebühr, Trainings
  mit Datum/Uhrzeit/Betrag, Zusatzposten mit Datum), seine Summe und am Ende die Gesamtsumme der Auswahl.
- Elternkonten sehen ausschließlich ihre zugeordneten Spieler und können nichts ändern.

## E-Mail und „Passwort vergessen“

- Versand über **Resend** mit dem Schlüssel aus der Railway-Variable `RESEND_API_KEY`; Absender
  `BetterTennis <no-reply@bettertennis.net>` (änderbar über `MAIL_FROM`). Links in E-Mails zeigen auf
  `https://bettertennis.net` (änderbar über `APP_URL`). Ohne Schlüssel startet die App normal, verschickt
  aber keine E-Mails (Hinweis im Log).
- **Mitglied → „Moji podaci“:** zeigt Vor- und Nachname und Benutzername (nur lesbar, ändert der Admin) und
  Felder für **E-mail** und **Telefon** mit einem Knopf „Spremi“. Kein Passwort beim ersten Eintragen der E-Mail
  und beim Ändern der Telefonnummer; nur wenn eine bereits eingetragene E-Mail geändert wird, fragt die Seite nach
  „Vaša lozinka za BetterTennis“ (Hinweis: Login-Passwort, nicht das Passwort des E-Mail-Kontos). Eine vorhandene
  E-Mail kann nicht geleert werden. Die alte Adresse `/mitglied/email` leitet hierher weiter. Passwort ändern bleibt
  unter „Lozinka“. Nicht für Kinder-Konten. Solange keine E-Mail hinterlegt ist, erscheint ein Hinweis auf der
  Startseite des Mitglieds (führt zu „Moji podaci“).
- **Login → „Zaboravljena lozinka?“:** E-Mail eingeben → Link (60 Minuten gültig, nur einmal verwendbar) →
  neues Passwort setzen. Der Benutzername bleibt immer gleich. Die Antwort verrät nicht, ob eine Adresse
  existiert; höchstens 3 Links pro Adresse und 20 Anfragen pro IP in 15 Minuten. Gilt für Mitglieder-Konten.
- **Admin:** pflegt beim Mitglied die E-Mail-Adresse (leer = keine E-Mail) und kann Passwörter wie bisher
  selbst zurücksetzen. Die Massenanlage bleibt ohne E-Mail.
- **Fenster nach dem Login:** Hat ein Mitglied noch keine E-Mail-Adresse, erscheint nach dem Login ein kleines Fenster
  („Molimo unesite svoju e-mail adresu …“) mit Eingabefeld, „Spremi“ und „Kasnije“ – höchstens bei den ersten drei
  Logins, nie mehr, sobald eine Mail eingetragen ist, nie bei Kinder-Konten. Der Hinweis auf der Seite bleibt wie bisher.

## Anwesenheit und Berechnung je Spieler (nur Admin)

- **Termini → Uredi → „Igrači“:** pro Spieler eine Spalte **Status** (Standard „–“; prisutan, nije došao/la,
  bolestan/na, povrijeđen/a, otkazao/la na vrijeme, otkazao/la prekasno, drugi razlog + kurze Notiz) – nur zur
  Dokumentation, **ohne Einfluss auf die Abrechnung** – und eine Spalte **Obračun** (nur bei „Prema rasporedu“):
  grüner Haken = wird berechnet; „Ne uključuj u obračun“ nimmt die Einheit für diesen Spieler heraus (grauer,
  durchgestrichener Haken), erneuter Klick nimmt sie wieder auf. Beim Speichern des Termins bleiben beide erhalten.
- **Iznosi → Detalji:** bei „Prema rasporedu“ und „Raspored s prikazom, bez obračuna“ Status je Einheit und eine
  Monats-Zusammenfassung (z. B. „8 prisutan, 1 bolestan/na“); bei „Prema rasporedu“ zusätzlich die Haken.
  Bei „Ručni unos“ unverändert. Mitglieder und Elternkonten sehen davon nichts.
- Bestehende Termine: kein Status („–“), alle in der Berechnung.

## E-Mails an Mitglieder (nur auf Knopfdruck)

Diese Mails gehen **nie automatisch** raus – nur, wenn der Admin Empfänger auswählt und „Pošalji“ drückt.
Versand über Resend (`RESEND_API_KEY`), Texte auf Bosnisch, jede Person bekommt eine eigene Mail.

- **Absage-Mail:** Bei einem abgesagten Termin (Termini → „Označi: Otkazan“) erscheint der Knopf
  „Pošalji e-mail o otkazivanju“. Die Seite listet alle Teilnehmer; optionales Textfeld für Grund/Nachricht
  (leer = neutrale, freundliche Absage). Die Mail enthält Trainingsart, ggf. Name der festen Gruppe, Datum, Uhrzeit, Platz.
- **Aktuelnosti:** In der Liste und auf der Detailseite einer Neuigkeit gibt es „Pošalji e-mailom“ – Liste aller
  aktiven Mitglieder, Mail mit Titel und Text.
- **Auswahlliste (beide gleich):** Kästchen, Name, E-Mail; ohne E-Mail „nije dostupno“ (nicht wählbar);
  oben „Označi sve“; nichts ist vorausgewählt. Wer für diesen Termin bzw. diese Neuigkeit schon eine Mail bekommen
  hat, ist als „već obaviješten/a“ markiert und wird nicht erneut angeschrieben.
- Fehlgeschlagener Versand: Grund im Log (Resend-Antwort + „… nije poslan na …“), Hinweis im Admin-Bereich.

## Privatstunden-Anfragen

- **Admin → „Privatni časovi“:** freie Termine anlegen (Datum, von–bis), blockieren / Blockierung aufheben, löschen.
  Darunter alle Anfragen (Name, angefragter Termin, Zeitpunkt der Anfrage), getrennt in „Otvoreni upiti“ und
  „Završeni upiti“; mit „✓ Označi kao završeno“ abhaken (rückgängig mit „Vrati u otvorene“).
- **Mitglieder → „Zatraži privatni čas“** (nur eingeloggte Mitglieder, nicht Kinder-Konten, nicht die Startseite):
  zeigt freie, nicht blockierte Termine, die noch nicht begonnen haben (Ortszeit Sarajevo). Klick → Sicherheitsabfrage
  „Želite li poslati upit za ovaj privatni čas?“ → „Da, pošalji upit“ speichert die Anfrage und zeigt
  „Hvala! Trener će vas uskoro kontaktirati.“ Ohne freie Termine: „Trenutno nema slobodnih termina.“
- Eine Anfrage blockiert den Termin **nicht** (andere Mitglieder können ihn weiter anfragen); dasselbe Mitglied kann
  einen Termin nur einmal anfragen. Nichts wird automatisch in den Trainingsplan übernommen.
- Bei jeder neuen Anfrage geht eine kurze Mail an **bettertennis.net@gmail.com** (Resend, `RESEND_API_KEY`;
  andere Adresse: `NOTIFY_EMAIL`). Das Mitglied bekommt keine Mail. Schlägt der Versand fehl, bleibt die Anfrage
  gespeichert und der Grund steht im Log.
- Wird ein Termin gelöscht, bleiben die Anfragen mit Datum und Uhrzeit erhalten.

## Automatische Sicherung per E-Mail

- **Jeden Sonntag um 22:00 Uhr (Sarajevo)** wird eine aktuelle Kopie der Datenbank – dieselbe Datei wie bei
  „Sigurnosna kopija“ – als Anhang an **bettertennis.net@gmail.com** geschickt (über Resend mit `RESEND_API_KEY`).
  Betreff und Text enthalten Datum und Uhrzeit der Sicherung.
- Der gesendete Termin wird in der Datenbank vermerkt (kein doppelter Versand nach einem Neustart). War der Server um
  22 Uhr nicht erreichbar, wird innerhalb von 24 Stunden nachgeholt. Bei einem Fehler: Grund im Log, neuer Versuch
  nach 30 Minuten.
- **Admin → Pregled → „Pošalji kopiju e-mailom sada“** schickt die Backup-Mail sofort (zum Testen).
- Andere Empfängeradresse: Variable `BACKUP_EMAIL`. Resend erlaubt Anhänge bis ca. 40 MB pro E-Mail.

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
| `PUBLIC_HOMEPAGE` | `0` = öffentliche Startseite (Početna) ausschalten, `/` leitet dann direkt zum Login | an |
| `RESEND_API_KEY` | Schlüssel für den E-Mail-Versand über Resend | – (keine E-Mails) |
| `MAIL_FROM`      | Absender der E-Mails | `BetterTennis <no-reply@bettertennis.net>` |
| `APP_URL`        | Adresse der Seite für Links in E-Mails | `https://bettertennis.net` (Railway) |
| `BACKUP_EMAIL`   | Empfänger der wöchentlichen Backup-Mail | `bettertennis.net@gmail.com` |
| `NOTIFY_EMAIL`   | Empfänger der Mail bei neuen Privatstunden-Anfragen | `bettertennis.net@gmail.com` |
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

Fotos der Startseite (alle frei nutzbar, Unsplash-Lizenz; geladen direkt von unsplash.com, lokale Ersatzbilder falls nicht erreichbar):
- Hauptbild (wechselt langsam): [Spielerin in Bewegung](https://unsplash.com/photos/a-woman-is-playing-tennis-on-a-tennis-court-yKMJLLtoDv4),
  [Aufschlag](https://unsplash.com/photos/man-serving-a-tennis-ball-on-a-court-AldB5IWh8l4),
  [Platz von oben](https://unsplash.com/photos/aerial-photography-of-two-person-playing-tennis-aG6ByqGXiXg),
  [Bälle am Netz](https://unsplash.com/photos/many-tennis-balls-scattered-on-a-court-near-net-LwxVG0VQ3RY)
- Karten (Individualni, Grupni, Video analiza, Konsultacije): Linien-Icons im Stil der Vorteile. **Eigene Fotos**
  einfach als `individualni.jpg`, `grupni.jpg`, `video-analiza.jpg` bzw. `konsultacije.jpg` (auch .jpeg/.png/.webp)
  in `public/img/programi/` legen – ohne Codeänderung erscheint dann das Foto statt des Icons (siehe LIESMICH.md dort).
- Lokales Ersatzbild: [Aleksandr Galichkin auf Unsplash](https://unsplash.com/photos/a-clay-tennis-court-with-lines-msx3rGYfOEc)

Design der Startseite: Dunkelblau, Hellblau, Weiß mit Neongelb-Akzent; Stile im Block „Početna (Startseite)“ am Ende von `public/style.css`.
(Unsplash-Lizenz, kostenlos nutzbar, Namensnennung nicht erforderlich – daher auf der Seite ohne Bildnachweis).
Das Foto liegt lokal unter `public/img/tennisplatz.jpg` und erscheint daher auch ohne Internetverbindung.

Sicherheit: Passwörter mit scrypt gehasht, HMAC-signierte HttpOnly-Cookies, CSRF-Token auf allen
Formularen, Content-Security-Policy, Begrenzung fehlgeschlagener Logins, alle Ausgaben HTML-escaped.
