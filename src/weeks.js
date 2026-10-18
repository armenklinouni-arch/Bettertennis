'use strict';

// Objava sedmičnog rasporeda: članovi (i dječiji računi) vide sedmicu tek kad je objavljena.
// Sedmica (ponedjeljak–nedjelja) se objavljuje ručno (admin) ili automatski u nedjelju prije te
// sedmice u 17:00 po sarajevskom vremenu – osim ako je admin za tu sedmicu isključio automatsku objavu.
const { addDays, mondayOf, isValidDate } = require('./dates');

const RELEASE_TIME_ZONE = 'Europe/Sarajevo';
const RELEASE_HOUR = 17;

// Pomak vremenske zone (ms) u datom trenutku, npr. +2 h ljeti, +1 h zimi.
function zoneOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

// Lokalno vrijeme u zoni (datum + sat) → UTC milisekunde.
function zonedTimeToUtc(dateISO, hour, timeZone) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

function isMonday(dateISO) {
  return isValidDate(dateISO) && mondayOf(dateISO) === dateISO;
}

// Nedjelja prije sedmice (dan prije ponedjeljka) u 17:00 po sarajevskom vremenu.
function autoReleaseAt(monday) {
  return zonedTimeToUtc(addDays(monday, -1), RELEASE_HOUR, RELEASE_TIME_ZONE);
}

function weekRow(db, monday) {
  return db.prepare('SELECT * FROM week_releases WHERE monday = ?').get(monday);
}

// Status sedmice. Automatska objava se pri prvom čitanju nakon roka trajno upisuje,
// tako da kasnije isključivanje automatske objave ne sakrije već objavljenu sedmicu.
function weekStatus(db, monday, now = Date.now()) {
  const row = weekRow(db, monday);
  const auto = row ? !!row.auto_release : true;
  const autoAt = autoReleaseAt(monday);
  if (row && row.released) {
    return { monday, released: true, auto, autoAt, releasedBy: row.released_by, releasedAt: row.released_at };
  }
  if (auto && now >= autoAt) {
    const releasedAt = new Date(autoAt).toISOString();
    db.prepare(
      `INSERT INTO week_releases (monday, released, released_by, released_at, auto_release) VALUES (?, 1, 'auto', ?, 1)
       ON CONFLICT(monday) DO UPDATE SET released = 1, released_by = 'auto', released_at = excluded.released_at`
    ).run(monday, releasedAt);
    return { monday, released: true, auto, autoAt, releasedBy: 'auto', releasedAt };
  }
  return { monday, released: false, auto, autoAt, releasedBy: null, releasedAt: null };
}

function isWeekReleased(db, dateISO, now = Date.now()) {
  return weekStatus(db, mondayOf(dateISO), now).released;
}

function releaseWeek(db, monday, now = Date.now()) {
  db.prepare(
    `INSERT INTO week_releases (monday, released, released_by, released_at) VALUES (?, 1, 'manual', ?)
     ON CONFLICT(monday) DO UPDATE SET released = 1, released_by = 'manual', released_at = excluded.released_at`
  ).run(monday, new Date(now).toISOString());
}

// Ponovo sakrij sedmicu. Ako je rok automatske objave već prošao, automatska objava se za tu
// sedmicu isključuje – inače bi sedmica odmah ponovo bila objavljena.
function hideWeek(db, monday, now = Date.now()) {
  const autoOff = now >= autoReleaseAt(monday);
  db.prepare(
    `INSERT INTO week_releases (monday, released, auto_release) VALUES (?, 0, ?)
     ON CONFLICT(monday) DO UPDATE SET released = 0, released_by = NULL, released_at = NULL,
       auto_release = CASE WHEN ? THEN 0 ELSE auto_release END`
  ).run(monday, autoOff ? 0 : 1, autoOff ? 1 : 0);
  return autoOff;
}

function setAutoRelease(db, monday, on) {
  db.prepare(
    `INSERT INTO week_releases (monday, auto_release) VALUES (?, ?)
     ON CONFLICT(monday) DO UPDATE SET auto_release = excluded.auto_release`
  ).run(monday, on ? 1 : 0);
}

module.exports = {
  autoReleaseAt, weekStatus, isWeekReleased, releaseWeek, hideWeek, setAutoRelease, isMonday,
  zonedTimeToUtc,
  RELEASE_TIME_ZONE, RELEASE_HOUR,
};
