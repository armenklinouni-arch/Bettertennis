'use strict';

// Dani u sedmici i "danas" ravnaju se po srednjoevropskom vremenu.
process.env.TZ = process.env.TZ || 'Europe/Berlin';

const { openDatabase, ensureAdmin } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || 'data/bettertennis.db';
const production = process.env.NODE_ENV === 'production';

const db = openDatabase(DB_FILE);
const created = ensureAdmin(db, {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
  name: process.env.ADMIN_NAME,
});
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  console.log(`Admin-Konto (fest eingestellt): ${process.env.ADMIN_EMAIL}`);
} else if (process.env.ADMIN_EMAIL || process.env.ADMIN_PASSWORD) {
  console.warn('Hinweis: Für einen festen Admin müssen ADMIN_EMAIL und ADMIN_PASSWORD beide gesetzt sein.');
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
  trustProxy: process.env.TRUST_PROXY === '1',
});

app.listen(PORT, () => {
  console.log(`BetterTennis radi na http://localhost:${PORT}`);
});
