'use strict';

// Kreira primjere članova, termina i zainteresovanih (samo za testiranje/prezentaciju).
// Pokretanje: npm run demo

process.env.TZ = process.env.TZ || 'Europe/Berlin';

const crypto = require('node:crypto');
const { openDatabase, ensureAdmin } = require('../src/db');
const { hashPassword } = require('../src/auth');
const D = require('../src/dates');
const { lessonPrice } = require('../src/money');

const db = openDatabase(process.env.DB_FILE || 'data/bettertennis.db');
const admin = ensureAdmin(db, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
if (admin) console.log(`Admin kreiran: ${admin.email} / ${admin.password}`);

const monday = D.mondayOf(D.todayISO());
const members = [
  { name: 'Amina Hodžić', email: 'amina@example.ba', rate: 4500, fee: 0, slots: [[0, '17:00', 60], [3, '18:00', 60]] },
  { name: 'Emir Begić', email: 'emir@example.ba', rate: 4000, fee: 1500, slots: [[1, '16:30', 90]] },
  { name: 'Lejla Kovačević', email: 'lejla@example.ba', rate: 5000, fee: 0, slots: [[2, '09:00', 60], [5, '10:00', 120]] },
];

const insertLesson = db.prepare(
  'INSERT INTO lessons (user_id, date, start_time, duration_min, court, price_cents) VALUES (?, ?, ?, ?, ?, ?)'
);
for (const m of members) {
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(m.email)) continue;
  const { lastInsertRowid: id } = db
    .prepare('INSERT INTO users (name, email, password_hash, hourly_rate_cents, monthly_fee_cents) VALUES (?, ?, ?, ?, ?)')
    .run(m.name, m.email, hashPassword('tennis123'), m.rate, m.fee);
  for (let week = -2; week < 6; week++) {
    for (const [day, time, duration] of m.slots) {
      insertLesson.run(id, D.addDays(monday, week * 7 + day), time, duration, String(1 + (id % 3)), lessonPrice(m.rate, duration));
    }
  }
}

// Grupni trening nedjeljom: Emir i Lejla (po jedan red po članu, isti group_id).
const emir = db.prepare('SELECT id FROM users WHERE email = ?').get('emir@example.ba');
const lejla = db.prepare('SELECT id FROM users WHERE email = ?').get('lejla@example.ba');
const hasGroup = db.prepare("SELECT 1 FROM lessons WHERE kind = 'group' LIMIT 1").get();
if (emir && lejla && !hasGroup) {
  const insertGroup = db.prepare(
    `INSERT INTO lessons (user_id, date, start_time, duration_min, court, price_cents, kind, group_id)
     VALUES (?, ?, '10:00', 90, '1', 3000, 'group', ?)`
  );
  for (let week = -2; week < 6; week++) {
    const groupId = crypto.randomUUID();
    for (const member of [emir, lejla]) insertGroup.run(member.id, D.addDays(monday, week * 7 + 6), groupId);
  }
}

if (!db.prepare('SELECT COUNT(*) AS n FROM leads').get().n) {
  db.prepare("INSERT INTO leads (name, email, phone, level, availability, message) VALUES ('Adnan Mehić', 'adnan@example.ba', '061 123 456', 'Početnik', 'ponedjeljkom i srijedom navečer', 'Želio bih početi igrati tenis.')").run();
  db.prepare("INSERT INTO leads (name, email, level, availability) VALUES ('Selma Hadžić', 'selma@example.ba', 'Povratnik', 'vikendom prijepodne')").run();
}

console.log('Demo podaci kreirani. Prijave članova: amina@example.ba, emir@example.ba, lejla@example.ba – lozinka: tennis123');
