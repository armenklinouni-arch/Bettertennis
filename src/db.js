'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username          TEXT COLLATE NOCASE,
  phone             TEXT,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
  monthly_fee_cents INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  billing_mode      TEXT NOT NULL DEFAULT 'schedule',
  parent_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  children_limit    INTEGER,
  email_prompt_logins INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  start_time   TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  court        TEXT,
  note         TEXT,
  price_cents  INTEGER NOT NULL DEFAULT 0,
  cancelled    INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual', 'group')),
  group_id     TEXT,
  trainer_id   INTEGER REFERENCES trainers(id) ON DELETE SET NULL,
  attendance      TEXT,
  attendance_note TEXT,
  billable        INTEGER NOT NULL DEFAULT 1,
  -- „Prikaz bez obračuna“: iznos i napomena samo za ovaj termin i ovog igrača (prazno = nije unesen)
  display_amount_cents INTEGER,
  display_note    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS lessons_user_date ON lessons (user_id, date);
CREATE INDEX IF NOT EXISTS lessons_date ON lessons (date);

CREATE TABLE IF NOT EXISTS adjustments (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS adjustments_user_month ON adjustments (user_id, month);

CREATE TABLE IF NOT EXISTS trainers (
  id                    INTEGER PRIMARY KEY,
  name                  TEXT NOT NULL,
  phone                 TEXT,
  email                 TEXT,
  username              TEXT COLLATE NOCASE,
  rate_individual_cents INTEGER NOT NULL DEFAULT 0,
  rate_group_cents      INTEGER NOT NULL DEFAULT 0,
  active                INTEGER NOT NULL DEFAULT 1,
  notes                 TEXT,
  password_hash         TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trainer_bonuses (
  id           INTEGER PRIMARY KEY,
  trainer_id   INTEGER NOT NULL REFERENCES trainers(id) ON DELETE CASCADE,
  month        TEXT NOT NULL,
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS trainer_bonuses_month ON trainer_bonuses (trainer_id, month);

CREATE TABLE IF NOT EXISTS training_groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_group_members (
  group_id INTEGER NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS finance_entries (
  id           INTEGER PRIMARY KEY,
  month        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category     TEXT NOT NULL,
  description  TEXT,
  amount_cents INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS finance_entries_month ON finance_entries (month);

CREATE TABLE IF NOT EXISTS payments (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month   TEXT NOT NULL,
  paid    INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  released INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

-- Obračun po mjesecu: vlastiti način obračuna i, za završene mjesece, sačuvani (zaključani) obračun.
CREATE TABLE IF NOT EXISTS billing_months (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month     TEXT NOT NULL,
  mode      TEXT,
  closed    INTEGER NOT NULL DEFAULT 0,
  reopened  INTEGER NOT NULL DEFAULT 0,
  snapshot  TEXT,
  closed_at TEXT,
  -- „Prikaz bez obračuna“: ručno određen iznos za treninge (prazno = zbir iznosa po terminima)
  display_total_cents INTEGER,
  PRIMARY KEY (user_id, month)
);

-- Objava sedmičnog rasporeda (monday = ponedjeljak sedmice). Bez reda: skrivena do automatske objave.
CREATE TABLE IF NOT EXISTS week_releases (
  monday       TEXT PRIMARY KEY,
  released     INTEGER NOT NULL DEFAULT 0,
  released_by  TEXT,
  released_at  TEXT,
  auto_release INTEGER NOT NULL DEFAULT 1
);

-- Elternkonto: übergeordnetes Konto (nur lesen), dem der Admin bestehende Spieler-Konten zuordnet.
CREATE TABLE IF NOT EXISTS parent_accounts (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS parent_accounts_username ON parent_accounts (username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS parent_account_players (
  parent_account_id INTEGER NOT NULL REFERENCES parent_accounts(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_account_id, user_id)
);

-- Linkovi za novu lozinku („Zaboravljena lozinka“): čuva se samo hash tokena; jednokratni, ističu nakon 60 min.
-- Prijave (sesije): kolačić nosi samo nasumični token, ovdje se čuva njegov hash.
-- Odjava i promjena lozinke brišu redove, pa djeluju odmah. kind: user | trainer | parent.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  account_id   INTEGER NOT NULL,
  remember     INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (kind, account_id);
-- Obrisan račun → njegove prijave se brišu (ID se u SQLite-u može ponovo dodijeliti novom računu).
CREATE TRIGGER IF NOT EXISTS sessions_users_delete AFTER DELETE ON users
  BEGIN DELETE FROM sessions WHERE kind = 'user' AND account_id = OLD.id; END;
CREATE TRIGGER IF NOT EXISTS sessions_trainers_delete AFTER DELETE ON trainers
  BEGIN DELETE FROM sessions WHERE kind = 'trainer' AND account_id = OLD.id; END;
CREATE TRIGGER IF NOT EXISTS sessions_parents_delete AFTER DELETE ON parent_accounts
  BEGIN DELETE FROM sessions WHERE kind = 'parent' AND account_id = OLD.id; END;

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ručno poslani e-mailovi (otkazivanje termina, aktuelnosti): ko je za šta već obaviješten.
CREATE TABLE IF NOT EXISTS notification_log (
  kind    TEXT NOT NULL,
  ref     TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email   TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, ref, user_id)
);

-- Privatni časovi: slobodni termini (admin) i upiti članova. Upit čuva datum/vrijeme termina,
-- da ostane čitljiv i ako se termin kasnije obriše.
CREATE TABLE IF NOT EXISTS private_slots (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  blocked    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS private_requests (
  id           INTEGER PRIMARY KEY,
  slot_id      INTEGER REFERENCES private_slots(id) ON DELETE SET NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_date    TEXT NOT NULL,
  slot_start   TEXT NOT NULL,
  slot_end     TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  done         INTEGER NOT NULL DEFAULT 0,
  done_at      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS private_requests_once ON private_requests (slot_id, user_id);

CREATE TABLE IF NOT EXISTS news (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS news_recipients (
  news_id INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT,
  PRIMARY KEY (news_id, user_id)
);
CREATE INDEX IF NOT EXISTS news_recipients_user ON news_recipients (user_id, read_at);

CREATE TABLE IF NOT EXISTS leads (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL,
  phone             TEXT,
  level             TEXT,
  availability      TEXT,
  message           TEXT,
  status            TEXT NOT NULL DEFAULT 'novo',
  converted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  addMissingColumns(db);
  relaxBillingModeCheck(db);
  db.exec(SCHEMA);
  db.exec('CREATE INDEX IF NOT EXISTS lessons_group ON lessons (group_id);');
  db.exec('CREATE INDEX IF NOT EXISTS lessons_trainer ON lessons (trainer_id, date);');
  migrateLeadStatuses(db);
  assignMissingUsernames(db);
  db.exec('CREATE INDEX IF NOT EXISTS users_parent ON users (parent_id);');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (username COLLATE NOCASE) WHERE username IS NOT NULL;");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS trainers_username ON trainers (username COLLATE NOCASE) WHERE username IS NOT NULL;");
  return db;
}

// ---------------------------------------------------------------- Korisnička imena
// Članovi i treneri se prijavljuju korisničkim imenom (admin i dalje e-mail adresom).
const USERNAME_RE = /^[a-z0-9._-]{3,40}$/;

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Korisničko ime mora biti jedinstveno među članovima, trenerima i roditeljskim računima zajedno.
function usernameTaken(db, username, { userId = 0, trainerId = 0, parentAccountId = 0 } = {}) {
  return !!db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(username, userId)
    || !!db.prepare('SELECT id FROM trainers WHERE username = ? COLLATE NOCASE AND id != ?').get(username, trainerId)
    || !!db.prepare('SELECT id FROM parent_accounts WHERE username = ? COLLATE NOCASE AND id != ?').get(username, parentAccountId);
}

// Prijedlog korisničkog imena iz e-maila ili imena (bez dijakritika, jedinstven).
function suggestUsername(db, source) {
  let base = String(source || '').split('@')[0].toLowerCase()
    .replace(/đ/g, 'dj').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 34);
  if (base.length < 3) base = `clan${base}`.slice(0, 34).padEnd(3, '0');
  let candidate = base;
  for (let i = 2; usernameTaken(db, candidate); i += 1) candidate = `${base}${i}`;
  return candidate;
}

// Članovi bez e-maila (lista članova, dječiji računi): baza zahtijeva jedinstven e-mail,
// pa dobijaju internu zamjensku adresu.
// Svaki član smije imati najviše jedan dječiji račun – fiksno za sve, bez izuzetaka.
const CHILDREN_LIMIT = 1;

const PLACEHOLDER_DOMAIN = 'bez-emaila.bettertennis.local';
function placeholderEmail(username) {
  return `${username}@${PLACEHOLDER_DOMAIN}`;
}
function isPlaceholderEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${PLACEHOLDER_DOMAIN}`);
}

// Prozor „unesite e-mail“ nakon prijave: samo član (ne dječiji račun) bez e-maila, najviše kod prve tri prijave.
const EMAIL_PROMPT_MAX_LOGINS = 3;
function needsEmailPrompt(user) {
  return !!user && user.role === 'member' && !user.parent_id
    && (!user.email || isPlaceholderEmail(user.email))
    && (user.email_prompt_logins || 0) < EMAIL_PROMPT_MAX_LOGINS;
}

// Postojeći članovi i treneri (iz vremena prijave e-mailom) jednom dobiju korisničko ime – podaci ostaju netaknuti.
function assignMissingUsernames(db) {
  const members = db.prepare("SELECT id, email FROM users WHERE role = 'member' AND (username IS NULL OR username = '') ORDER BY id").all();
  const trainers = db.prepare("SELECT id, email, name FROM trainers WHERE username IS NULL OR username = '' ORDER BY id").all();
  if (members.length === 0 && trainers.length === 0) return;
  const setUser = db.prepare('UPDATE users SET username = ? WHERE id = ?');
  const setTrainer = db.prepare('UPDATE trainers SET username = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const m of members) setUser.run(suggestUsername(db, m.email), m.id);
    for (const t of trainers) setTrainer.run(suggestUsername(db, t.email || t.name), t.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Starije baze nemaju nove kolone – dodajemo ih bez gubitka podataka.
const NEW_COLUMNS = [
  ['users', 'billing_mode', "TEXT NOT NULL DEFAULT 'schedule'"],
  ['lessons', 'kind', "TEXT NOT NULL DEFAULT 'individual'"],
  ['lessons', 'group_id', 'TEXT'],
  ['lessons', 'trainer_id', 'INTEGER REFERENCES trainers(id) ON DELETE SET NULL'],
  ['trainers', 'password_hash', 'TEXT'],
  ['payments', 'released', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'username', 'TEXT COLLATE NOCASE'],
  ['trainers', 'username', 'TEXT COLLATE NOCASE'],
  // Dječiji račun: član kojeg je kreirao roditelj (vidi samo svoj sedmični raspored).
  ['users', 'parent_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE'],
  // Ranije: individualni limit dječijih računa. Više se ne koristi (limit je fiksan, vidi CHILDREN_LIMIT),
  // kolona ostaje da postojeći podaci ostanu netaknuti.
  ['users', 'children_limit', 'INTEGER'],
  // Prisustvo igrača (samo dokumentacija, ne utiče na obračun) i ručno isključenje iz obračuna.
  ['lessons', 'attendance', 'TEXT'],
  ['lessons', 'attendance_note', 'TEXT'],
  ['lessons', 'billable', 'INTEGER NOT NULL DEFAULT 1'],
  // Koliko puta je članu bez e-maila nakon prijave prikazan prozor za unos e-maila (najviše 3 puta).
  ['users', 'email_prompt_logins', 'INTEGER NOT NULL DEFAULT 0'],
  // „Prikaz bez obračuna“: iznos/napomena po terminu i ručni iznos za treninge u mjesecu (sve prazno = kao ranije).
  ['lessons', 'display_amount_cents', 'INTEGER'],
  ['lessons', 'display_note', 'TEXT'],
  ['billing_months', 'display_total_cents', 'INTEGER'],
];

function addMissingColumns(db) {
  for (const [table, column, definition] of NEW_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.length > 0 && !columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

// Jedna ranija verzija je u tabeli users imala CHECK koji dozvoljava samo 'schedule' i 'manual'.
// SQLite ne može mijenjati CHECK, pa tabelu jednom ponovo kreiramo bez njega (podaci ostaju).
function relaxBillingModeCheck(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!row || !row.sql.includes('CHECK (billing_mode')) return;
  const newSql = row.sql
    .replace(/CREATE TABLE "?users"?/, 'CREATE TABLE users_new')
    .replace(/\s*CHECK \(billing_mode IN \([^)]*\)\)/, '');
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN');
  try {
    db.exec(newSql);
    db.exec('INSERT INTO users_new SELECT * FROM users;');
    db.exec('DROP TABLE users;');
    db.exec('ALTER TABLE users_new RENAME TO users;');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

// Statusi upita su ranije bili na njemačkom – prevodimo postojeće zapise.
const OLD_LEAD_STATUSES = {
  neu: 'novo',
  kontaktiert: 'kontaktiran',
  Probestunde: 'probni trening',
  Mitglied: 'član',
  abgelehnt: 'odbijen',
};

function migrateLeadStatuses(db) {
  const update = db.prepare('UPDATE leads SET status = ? WHERE status = ?');
  for (const [oldStatus, newStatus] of Object.entries(OLD_LEAD_STATUSES)) update.run(newStatus, oldStatus);
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

// Tajni ključ za potpisivanje session-kolačića: iz okruženja ili jednom generisan i sačuvan.
function sessionSecret(db, fromEnv) {
  if (fromEnv) return fromEnv;
  let secret = getSetting(db, 'session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'session_secret', secret);
  }
  return secret;
}

// Pri prvom pokretanju kreira administratorski račun ako još ne postoji.
// Vraća generisanu lozinku ako je nasumično kreirana.
function ensureAdmin(db, { email, password, name } = {}) {
  // Fiksni admin iz podešavanja (ADMIN_EMAIL + ADMIN_PASSWORD): pri svakom pokretanju se osigura
  // da ovaj račun postoji, da je admin i aktivan te da vrijedi zadana lozinka.
  if (email && password) {
    const account = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (account) {
      const unchanged = verifyPassword(password, account.password_hash);
      const hash = unchanged ? account.password_hash : hashPassword(password);
      db.prepare("UPDATE users SET role = 'admin', active = 1, password_hash = ? WHERE id = ?").run(hash, account.id);
      // Nova lozinka iz podešavanja → postojeće prijave ovog računa prestaju važiti.
      if (!unchanged) db.prepare("DELETE FROM sessions WHERE kind = 'user' AND account_id = ?").run(account.id);
    } else {
      db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
        .run(name || 'Administrator', email, hashPassword(password));
    }
    return null;
  }

  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return null;
  const adminEmail = email || 'admin@bettertennis.local';
  const adminPassword = password || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(name || 'Administrator', adminEmail, hashPassword(adminPassword));
  return password ? null : { email: adminEmail, password: adminPassword };
}

module.exports = {
  openDatabase, getSetting, setSetting, sessionSecret, ensureAdmin,
  USERNAME_RE, normalizeUsername, usernameTaken, suggestUsername, placeholderEmail, isPlaceholderEmail, needsEmailPrompt, EMAIL_PROMPT_MAX_LOGINS,
  CHILDREN_LIMIT,
};
