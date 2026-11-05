'use strict';

// Dnevnik aktivnosti: svaka izmjena se automatski bilježi (ko, kada, oblast, kratak opis na bosanskom).
// Samo za čitanje – zapisi se ne mogu mijenjati. Zapisi stariji od 12 mjeseci se automatski brišu.
// Lozinke se nikad ne upisuju (samo „lozinka promijenjena“).
const { formatMoney } = require('./money');
const { searchText } = require('./search');

const AREAS = [
  'Zainteresovani', 'Članovi', 'Grupe', 'Treneri', 'Roditelji', 'Termini', 'Iznosi', 'Finansije',
  'Aktuelnosti', 'Privatni časovi', 'Sistem',
];
const KEEP_MONTHS = 12;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const lastCleanup = new WeakMap();

// Ko je napravio izmjenu (iz prijavljenog računa).
function actorOf(req) {
  const u = req && req.user;
  if (!u) return { role: 'posjetilac', name: 'Posjetilac (javni obrazac)' };
  if (u.role === 'admin') return { role: 'admin', name: `Admin – ${u.name}` };
  if (u.role === 'parent') return { role: 'roditelj', name: `Roditeljski račun – ${u.name}` };
  if (u.role === 'trainer') return { role: 'trener', name: `Trener – ${u.name}` };
  if (u.parent_id) return { role: 'dijete', name: `Dječiji račun – ${u.name}` };
  return { role: 'clan', name: `Član – ${u.name}` };
}

function cutoffISO(now = Date.now()) {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - KEEP_MONTHS);
  return d.toISOString();
}

function cleanupActivity(db, now = Date.now()) {
  db.prepare('DELETE FROM activity_log WHERE at < ?').run(cutoffISO(now));
  lastCleanup.set(db, now);
}

// Upis jednog zapisa. text: opis bez naziva oblasti (oblast se prikazuje ispred).
function logActivity(db, req, area, text) {
  if (!text) return;
  const now = Date.now();
  const actor = actorOf(req);
  const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, 1000);
  db.prepare('INSERT INTO activity_log (at, actor_role, actor_name, area, text, search) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date(now).toISOString(), actor.role, actor.name, AREAS.includes(area) ? area : 'Sistem', clean, searchText(actor.name, clean));
  const last = lastCleanup.get(db);
  if (last === undefined || now - last >= CLEANUP_EVERY_MS || now < last) cleanupActivity(db, now);
}

// Pomoćne funkcije za opis promjena „staro → novo“.
const show = (v) => (v === null || v === undefined || v === '' ? '–' : String(v));
const money = (cents) => (cents === null || cents === undefined ? '–' : formatMoney(cents));
// Lista promjena: [['Cijena po satu', staro, novo], …] → „Cijena po satu: 40,00 KM → 30,00 KM, …“
function changes(list) {
  return list
    .filter(([, before, after]) => show(before) !== show(after))
    .map(([label, before, after]) => `${label}: ${show(before)} → ${show(after)}`)
    .join(', ');
}

module.exports = { logActivity, cleanupActivity, changes, money, show, AREAS, KEEP_MONTHS };
