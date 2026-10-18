'use strict';

// Automatska sigurnosna kopija: svake nedjelje u 22:00 (sarajevsko vrijeme) šalje se kopija baze
// (ista datoteka kao kod dugmeta „Sigurnosna kopija“) kao prilog e-mailom. Admin je može poslati i ručno.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addDays } = require('./dates');
const { zonedTimeToUtc } = require('./weeks');
const { getSetting, setSetting } = require('./db');

const BACKUP_EMAIL_DEFAULT = 'bettertennis.net@gmail.com';
const TIME_ZONE = 'Europe/Sarajevo';
const BACKUP_HOUR = 22; // nedjelja, 22:00
const CATCH_UP_MS = 24 * 60 * 60 * 1000; // propušteni termin (npr. server ugašen) šalje se još 24 h kasnije
const RETRY_MS = 30 * 60 * 1000; // nakon greške ponovni pokušaj tek za 30 minuta
const MAX_ATTACHMENT_BYTES = 35 * 1024 * 1024; // Resend: najviše 40 MB po poruci (s rezervom)

// Datum i vrijeme u Sarajevu za zadani trenutak.
function sarajevoParts(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { ...parts, date: `${parts.year}-${parts.month}-${parts.day}` };
}

// Posljednji redovni termin (nedjelja 22:00 Sarajevo) koji nije u budućnosti, kao UTC milisekunde.
function backupSlot(now = Date.now()) {
  const p = sarajevoParts(now);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  let sunday = addDays(p.date, -weekday);
  let slot = zonedTimeToUtc(sunday, BACKUP_HOUR, TIME_ZONE);
  if (slot > now) {
    sunday = addDays(sunday, -7);
    slot = zonedTimeToUtc(sunday, BACKUP_HOUR, TIME_ZONE);
  }
  return slot;
}

// Konzistentna kopija cijele baze (VACUUM INTO), kao kod preuzimanja.
function backupBuffer(db) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-mailbackup-'));
  try {
    const file = path.join(dir, 'backup.db');
    db.prepare('VACUUM INTO ?').run(file);
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Šalje e-mail sa sigurnosnom kopijom. Vraća { ok, error }; razlog greške se uvijek zapisuje u log.
async function sendBackupMail(db, mailer, { to = BACKUP_EMAIL_DEFAULT, now = Date.now(), reason = 'ručno' } = {}) {
  const p = sarajevoParts(now);
  const label = `${p.day}.${p.month}.${p.year}. ${p.hour}:${p.minute}`;
  const fail = (error) => {
    console.error(`Sigurnosna kopija (${reason}, ${label}) nije poslana na ${to}: ${error}`);
    return { ok: false, error };
  };
  let data;
  try {
    data = backupBuffer(db);
  } catch (err) {
    return fail(`kopija baze nije napravljena – ${err.message}`);
  }
  if (data.length > MAX_ATTACHMENT_BYTES) {
    return fail(`baza je prevelika za prilog (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  const filename = `bettertennis-${p.date}-${p.hour}${p.minute}.db`;
  const sizeKb = Math.max(1, Math.round(data.length / 1024));
  let ok = false;
  try {
    ok = await mailer.send({
      to,
      subject: `BetterTennis – sigurnosna kopija baze (${label})`,
      text: `Sigurnosna kopija baze podataka BetterTennis.\n\n`
        + `Napravljena: ${p.day}.${p.month}.${p.year}. u ${p.hour}:${p.minute} (sarajevsko vrijeme, Europe/Sarajevo)\n`
        + `Datoteka u prilogu: ${filename} (${sizeKb} KB)\n`
        + `Vrsta: ${reason === 'automatski' ? 'automatska sedmična kopija (nedjelja 22:00)' : 'ručno pokrenuta iz admin dijela'}\n\n`
        + 'Datoteku sačuvaj na sigurnom mjestu. Za vraćanje podataka postavi je kao datoteku baze (DB_FILE).\n\nBetterTennis',
      attachments: [{ filename, content: data.toString('base64') }],
    });
  } catch (err) {
    return fail(err.message);
  }
  if (!ok) return fail('slanje preko Resenda nije uspjelo (detalji u liniji iznad; npr. RESEND_API_KEY nije podešen)');
  console.log(`Sigurnosna kopija (${reason}, ${label}) poslana na ${to} (${filename}, ${sizeKb} KB).`);
  return { ok: true, filename };
}

// Jedan „otkucaj“ rasporeda: šalje kopiju ako je aktuelni nedjeljni termin prošao, a još nije poslan.
// Poslani termin se pamti u bazi (postavka backup_last_slot) – i nakon restarta nema duplog slanja.
async function runScheduledBackup(db, mailer, { now = Date.now(), state = {}, to = BACKUP_EMAIL_DEFAULT } = {}) {
  const slot = backupSlot(now);
  const slotIso = new Date(slot).toISOString();
  if (getSetting(db, 'backup_last_slot') === slotIso) return 'skipped';
  if (now - slot > CATCH_UP_MS) return 'skipped';
  if (state.lastFailure && state.lastFailureSlot === slotIso && now - state.lastFailure < RETRY_MS) return 'skipped';
  const result = await sendBackupMail(db, mailer, { to, now, reason: 'automatski' });
  if (!result.ok) {
    state.lastFailure = now;
    state.lastFailureSlot = slotIso;
    return 'failed';
  }
  setSetting(db, 'backup_last_slot', slotIso);
  return 'sent';
}

// Pokreće provjeru svake minute (samo u server.js, ne u testovima).
function startBackupScheduler(db, mailer, { to = BACKUP_EMAIL_DEFAULT, intervalMs = 60 * 1000 } = {}) {
  const state = {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runScheduledBackup(db, mailer, { state, to });
    } catch (err) {
      console.error('Sigurnosna kopija: greška u rasporedu –', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

module.exports = {
  sendBackupMail, runScheduledBackup, startBackupScheduler, backupSlot, BACKUP_EMAIL_DEFAULT,
};
