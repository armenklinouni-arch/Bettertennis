'use strict';

// Dani u sedmici i "danas" ravnaju se po srednjoevropskom vremenu.
process.env.TZ = process.env.TZ || 'Europe/Berlin';

const path = require('node:path');
const { openDatabase, ensureAdmin } = require('./db');
const { createApp } = require('./app');
const { createResendMailer } = require('./mailer');

const PORT = Number(process.env.PORT) || 3000;
// Baza podataka: DB_FILE ima prednost; na Railwayu se automatski koristi priključeni Volume,
// tako da podaci ostaju sačuvani i nakon novog deploya.
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_FILE = process.env.DB_FILE || (VOLUME ? path.join(VOLUME, 'bettertennis.db') : 'data/bettertennis.db');
const production = process.env.NODE_ENV === 'production';

// Vrijednosti iz podešavanja (npr. Railway „Variables“): uklanjamo razmake i navodnike
// koji se lako slučajno upišu oko vrijednosti.
function cleanEnv(name) {
  const value = (process.env[name] || '').trim();
  const quoted = value.length >= 2 && /^(["']).*\1$/.test(value);
  return quoted ? value.slice(1, -1) : value;
}

const adminEmail = cleanEnv('ADMIN_EMAIL');
const adminPassword = cleanEnv('ADMIN_PASSWORD');

const db = openDatabase(DB_FILE);
console.log(`Datenbank: ${path.resolve(DB_FILE)}`);
if (process.env.RAILWAY_ENVIRONMENT && !VOLUME && !process.env.DB_FILE) {
  console.warn('############################################################');
  console.warn('ACHTUNG: Kein Railway-Volume angebunden! Alle Daten (Mitglieder,');
  console.warn('Termine, Zahlungen) gehen bei jedem Deploy verloren.');
  console.warn('Lösung: Im Railway-Dienst ein Volume mit Mount-Pfad /data anlegen.');
  console.warn('############################################################');
}
const created = ensureAdmin(db, {
  email: adminEmail,
  password: adminPassword,
  name: cleanEnv('ADMIN_NAME'),
});
if (adminEmail && adminPassword) {
  console.log(`Admin-Konto (fest eingestellt): ${adminEmail} (Passwortlänge: ${adminPassword.length} Zeichen)`);
} else if (adminEmail || adminPassword) {
  console.warn('Hinweis: Für einen festen Admin müssen ADMIN_EMAIL und ADMIN_PASSWORD beide gesetzt sein.');
} else {
  console.warn('Hinweis: ADMIN_EMAIL / ADMIN_PASSWORD sind nicht gesetzt – es wird kein fester Admin verwendet.');
}
console.log(cleanEnv('RESEND_API_KEY') ? 'E-Mail-Versand: Resend aktiv.' : 'Hinweis: RESEND_API_KEY ist nicht gesetzt – es werden keine E-Mails verschickt.');
if (created) {
  console.log('------------------------------------------------------------');
  console.log('Kreiran je administratorski račun:');
  console.log(`  E-mail:  ${created.email}`);
  console.log(`  Lozinka: ${created.password}`);
  console.log('Molimo promijenite lozinku nakon prve prijave.');
  console.log('------------------------------------------------------------');
}

const app = createApp(db, {
  secret: process.env.SESSION_SECRET,
  secureCookies: production,
  // Hinter einem Proxy (z. B. Railway) die echte Besucher-IP verwenden (wichtig für die Login-Sperre).
  trustProxy: process.env.TRUST_PROXY === '1' || !!process.env.RAILWAY_ENVIRONMENT,
  // Öffentliche Startseite nur mit PUBLIC_HOMEPAGE=1, sonst landet man direkt beim Login.
  publicHomepage: cleanEnv('PUBLIC_HOMEPAGE') === '1',
  // E-Mails (Passwort vergessen) über Resend; Links zeigen immer auf die feste Adresse der Seite.
  mailer: createResendMailer({ apiKey: cleanEnv('RESEND_API_KEY'), from: cleanEnv('MAIL_FROM') || undefined }),
  appUrl: (cleanEnv('APP_URL') || (process.env.RAILWAY_ENVIRONMENT ? 'https://bettertennis.net' : `http://localhost:${PORT}`)).replace(/\/+$/, ''),
});

app.listen(PORT, () => {
  console.log(`BetterTennis radi na http://localhost:${PORT}`);
});
