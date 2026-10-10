'use strict';

// Dani u sedmici i "danas" ravnaju se po srednjoevropskom vremenu.
process.env.TZ = process.env.TZ || 'Europe/Berlin';

const { openDatabase, ensureAdmin } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || 'data/bettertennis.db';
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
});

app.listen(PORT, () => {
  console.log(`BetterTennis radi na http://localhost:${PORT}`);
});
