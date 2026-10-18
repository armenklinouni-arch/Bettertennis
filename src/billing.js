'use strict';

const { monthRange, monthOf, addMonths, todayISO } = require('./dates');

// Načini obračuna – podešavaju se za svakog člana i svaki mjesec posebno (tabela billing_months):
//  - schedule: realizovani treninzi iz rasporeda se automatski obračunavaju
//  - display:  treninzi se prikazuju u obračunu, ali se ne naplaćuju
//  - manual:   treninzi se ne prikazuju; iznos se unosi samo ručno kao stavke
const BILLING_MODES = {
  schedule: 'Prema rasporedu (realizovani treninzi se automatski obračunavaju)',
  display: 'Raspored s prikazom, bez obračuna (termini se vide, ali se ne naplaćuju)',
  manual: 'Ručni unos (bez rasporeda – iznos unosiš kao stavke)',
};
const BILLING_MODE_SHORT = { schedule: 'prema rasporedu', display: 'prikaz bez obračuna', manual: 'ručni obračun' };

// Ranije je način obračuna bio jedan za člana (users.billing_mode). Ta vrijednost se više ne mijenja
// i služi samo kao polazna vrijednost za mjesece koji još nemaju vlastitu postavku.
function billingMode(user) {
  return BILLING_MODES[user.billing_mode] ? user.billing_mode : 'schedule';
}

// Članovi vide plaćanja samo za tekući mjesec i tri mjeseca unazad.
const MEMBER_MONTHS_BACK = 3;

function memberMonthRange(today = todayISO()) {
  const current = monthOf(today);
  return { min: addMonths(current, -MEMBER_MONTHS_BACK), max: current };
}

function monthRecord(db, userId, month) {
  return db.prepare('SELECT * FROM billing_months WHERE user_id = ? AND month = ?').get(userId, month);
}

// Način obračuna koji vrijedi za mjesec: vlastita postavka mjeseca, inače polazna vrijednost člana.
function modeForMonth(db, user, month) {
  const rec = monthRecord(db, user.id, month);
  return rec && BILLING_MODES[rec.mode] ? rec.mode : billingMode(user);
}

// Obračun izračunat iz trenutnih podataka (raspored, članarina, stavke).
function liveStatement(db, user, month, mode) {
  const { first, last } = monthRange(month);
  const lessons = mode === 'manual' ? [] : db
    .prepare(
      `SELECT * FROM lessons
        WHERE user_id = ? AND date BETWEEN ? AND ?
        ORDER BY date, start_time`
    )
    .all(user.id, first, last);
  const adjustments = db
    .prepare('SELECT * FROM adjustments WHERE user_id = ? AND month = ? ORDER BY id')
    .all(user.id, month);

  const realized = lessons.filter((l) => !l.cancelled);
  const billLessons = mode === 'schedule';
  // Ručno isključeni termini (billable = 0) se ne naplaćuju. Status prisustva ovdje namjerno ne igra ulogu.
  const lessonsTotal = billLessons ? realized.filter((l) => l.billable !== 0).reduce((sum, l) => sum + l.price_cents, 0) : 0;
  const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount_cents, 0);
  const minutes = realized.reduce((sum, l) => sum + l.duration_min, 0);
  const fee = user.monthly_fee_cents || 0;
  return {
    mode,
    lessons,
    adjustments,
    fee,
    lessonCount: realized.length,
    hours: minutes / 60,
    lessonsTotal,
    adjustmentsTotal,
    total: fee + lessonsTotal + adjustmentsTotal,
  };
}

// Zaključavanje mjeseca: obračun se sačuva kakav jeste (način, članarina, termini, stavke, iznosi)
// i od tada se prikazuje upravo taj sačuvani obračun – kasnije promjene ga ne mijenjaju.
function closeMonth(db, user, month) {
  const snapshot = liveStatement(db, user, month, modeForMonth(db, user, month));
  db.prepare(
    `INSERT INTO billing_months (user_id, month, mode, closed, reopened, snapshot, closed_at)
     VALUES (?, ?, ?, 1, 0, ?, datetime('now'))
     ON CONFLICT(user_id, month) DO UPDATE SET mode = excluded.mode, closed = 1, reopened = 0,
       snapshot = excluded.snapshot, closed_at = excluded.closed_at`
  ).run(user.id, month, snapshot.mode, JSON.stringify(snapshot));
  return monthRecord(db, user.id, month);
}

// Admin svjesno otključava prošli mjesec za retroaktivne izmjene. Dok ga ponovo ne zaključi,
// mjesec se računa iz trenutnih podataka i ne zaključava se automatski.
function reopenMonth(db, userId, month) {
  db.prepare('UPDATE billing_months SET closed = 0, reopened = 1 WHERE user_id = ? AND month = ?').run(userId, month);
}

// Postavlja način obračuna samo za ovaj jedan mjesec (zaključan mjesec se ne mijenja).
function setMonthMode(db, userId, month, mode) {
  if (!BILLING_MODES[mode]) throw new Error(`Nepoznat način obračuna: ${mode}`);
  const rec = monthRecord(db, userId, month);
  if (rec && rec.closed) return false;
  db.prepare(
    `INSERT INTO billing_months (user_id, month, mode) VALUES (?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET mode = excluded.mode`
  ).run(userId, month, mode);
  return true;
}

// Završeni mjeseci (prije tekućeg) se automatski zaključavaju – osim ako ih je admin otključao.
function needsClosing(rec, month, current) {
  return month < current && (!rec || (!rec.closed && !rec.reopened));
}

function isMonthClosed(db, user, month) {
  return !!monthlyStatement(db, user, month).closed;
}

// Zaključava sve završene mjesece svih članova (od prvog mjeseca s podacima do prošlog mjeseca).
function closeElapsedMonths(db, current = monthOf(todayISO())) {
  const members = db.prepare("SELECT * FROM users WHERE role = 'member'").all();
  const firstMonth = db.prepare(
    `SELECT MIN(m) AS m FROM (
       SELECT substr(created_at, 1, 7) AS m FROM users WHERE id = ?1
       UNION ALL SELECT substr(MIN(date), 1, 7) FROM lessons WHERE user_id = ?1
       UNION ALL SELECT MIN(month) FROM adjustments WHERE user_id = ?1
       UNION ALL SELECT MIN(month) FROM payments WHERE user_id = ?1
       UNION ALL SELECT MIN(month) FROM billing_months WHERE user_id = ?1)`
  );
  let closed = 0;
  db.exec('BEGIN');
  try {
    for (const user of members) {
      const start = firstMonth.get(user.id).m;
      if (!start) continue;
      for (let month = start; month < current; month = addMonths(month, 1)) {
        if (needsClosing(monthRecord(db, user.id, month), month, current)) {
          closeMonth(db, user, month);
          closed += 1;
        }
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return closed;
}

// Mjesečni pregled člana: osnovna članarina + obračunati treninzi + ručno dodane stavke.
// Samo informativno – nikakvo plaćanje se ne vrši kroz aplikaciju.
function monthlyStatement(db, user, month) {
  const current = monthOf(todayISO());
  let rec = monthRecord(db, user.id, month);
  if (needsClosing(rec, month, current)) rec = closeMonth(db, user, month);
  const closed = !!(rec && rec.closed && rec.snapshot);
  const data = closed ? JSON.parse(rec.snapshot) : liveStatement(db, user, month, modeForMonth(db, user, month));
  const payment = db.prepare('SELECT * FROM payments WHERE user_id = ? AND month = ?').get(user.id, month);

  return {
    ...data,
    month,
    manual: data.mode === 'manual',
    billLessons: data.mode === 'schedule',
    // Zaključan mjesec: prikazuje se sačuvani obračun; otključan: admin ga je svjesno otvorio za izmjene.
    closed,
    closedAt: closed ? rec.closed_at : null,
    reopened: !!(rec && rec.reopened && !rec.closed),
    past: month < current,
    paid: !!(payment && payment.paid),
    // Član vidi obračun tek kad ga admin odobri; do tada piše „Obračun u pripremi“.
    released: !!(payment && payment.released),
    paidAt: payment && payment.paid ? payment.paid_at : null,
  };
}

// Za admina: iznos kakav bi bio da se zaključan mjesec sada ponovo izračuna.
function liveTotal(db, user, month) {
  return liveStatement(db, user, month, modeForMonth(db, user, month)).total;
}

function setPaid(db, userId, month, paid) {
  db.prepare(
    `INSERT INTO payments (user_id, month, paid, paid_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET paid = excluded.paid, paid_at = excluded.paid_at`
  ).run(userId, month, paid ? 1 : 0, paid ? todayISO() : null);
}

function setReleased(db, userId, month, released) {
  db.prepare(
    `INSERT INTO payments (user_id, month, released) VALUES (?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET released = excluded.released`
  ).run(userId, month, released ? 1 : 0);
}

function formatHours(hours) {
  return `${hours.toLocaleString('bs-BA', { maximumFractionDigits: 2 })} h`;
}

module.exports = {
  monthlyStatement, setPaid, setReleased, formatHours, billingMode, memberMonthRange,
  setMonthMode, closeMonth, reopenMonth, closeElapsedMonths, isMonthClosed, liveTotal, modeForMonth,
  BILLING_MODES, BILLING_MODE_SHORT, MEMBER_MONTHS_BACK,
};
