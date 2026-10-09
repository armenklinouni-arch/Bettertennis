'use strict';

const { monthRange, monthOf, addMonths, todayISO } = require('./dates');

// Načini obračuna po članu (users.billing_mode):
//  - schedule: realizovani treninzi iz rasporeda se automatski obračunavaju
//  - display:  treninzi se prikazuju u obračunu, ali se ne naplaćuju
//  - manual:   treninzi se ne prikazuju; iznos se unosi samo ručno kao stavke
const BILLING_MODES = {
  schedule: 'Prema rasporedu (realizovani treninzi se automatski obračunavaju)',
  display: 'Raspored s prikazom, bez obračuna (termini se vide, ali se ne naplaćuju)',
  manual: 'Ručni unos (bez rasporeda – iznos unosiš kao stavke)',
};
const BILLING_MODE_SHORT = { schedule: 'prema rasporedu', display: 'prikaz bez obračuna', manual: 'ručni obračun' };

function billingMode(user) {
  return BILLING_MODES[user.billing_mode] ? user.billing_mode : 'schedule';
}

// Članovi vide plaćanja samo za tekući mjesec i tri mjeseca unazad.
const MEMBER_MONTHS_BACK = 3;

function memberMonthRange(today = todayISO()) {
  const current = monthOf(today);
  return { min: addMonths(current, -MEMBER_MONTHS_BACK), max: current };
}

// Mjesečni pregled člana: osnovna članarina + obračunati treninzi + ručno dodane stavke.
// Samo informativno – nikakvo plaćanje se ne vrši kroz aplikaciju.
function monthlyStatement(db, user, month) {
  const { first, last } = monthRange(month);
  const mode = billingMode(user);
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
  const payment = db.prepare('SELECT * FROM payments WHERE user_id = ? AND month = ?').get(user.id, month);

  const realized = lessons.filter((l) => !l.cancelled);
  const billLessons = mode === 'schedule';
  const lessonsTotal = billLessons ? realized.reduce((sum, l) => sum + l.price_cents, 0) : 0;
  const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount_cents, 0);
  const minutes = realized.reduce((sum, l) => sum + l.duration_min, 0);
  const fee = user.monthly_fee_cents || 0;

  return {
    month,
    mode,
    manual: mode === 'manual',
    billLessons,
    lessons,
    adjustments,
    fee,
    lessonCount: realized.length,
    hours: minutes / 60,
    lessonsTotal,
    adjustmentsTotal,
    total: fee + lessonsTotal + adjustmentsTotal,
    paid: !!(payment && payment.paid),
    // Član vidi obračun tek kad ga admin odobri; do tada piše „Obračun u pripremi“.
    released: !!(payment && payment.released),
    paidAt: payment && payment.paid ? payment.paid_at : null,
  };
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
  BILLING_MODES, BILLING_MODE_SHORT, MEMBER_MONTHS_BACK,
};
