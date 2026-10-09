'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone             TEXT,
  password_hash     TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
  monthly_fee_cents INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  billing_mode      TEXT NOT NULL DEFAULT 'schedule' CHECK (billing_mode IN ('schedule', 'manual')),
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
  db.exec(SCHEMA);
  db.exec('CREATE INDEX IF NOT EXISTS lessons_group ON lessons (group_id);');
  migrateLeadStatuses(db);
  return db;
}

// Starije baze nemaju nove kolone – dodajemo ih bez gubitka podataka.
const NEW_COLUMNS = [
  ['users', 'billing_mode', "TEXT NOT NULL DEFAULT 'schedule'"],
  ['lessons', 'kind', "TEXT NOT NULL DEFAULT 'individual'"],
  ['lessons', 'group_id', 'TEXT'],
];

function addMissingColumns(db) {
  for (const [table, column, definition] of NEW_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.length > 0 && !columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
  const existing = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existing) return null;
  const adminEmail = email || 'admin@bettertennis.local';
  const adminPassword = password || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
    .run(name || 'Administrator', adminEmail, hashPassword(adminPassword));
  return password ? null : { email: adminEmail, password: adminPassword };
}

module.exports = { openDatabase, getSetting, setSetting, sessionSecret, ensureAdmin };
