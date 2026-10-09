'use strict';

const { monthRange } = require('./dates');

// Mjesečni pregled člana: osnovna članarina + realizovani treninzi + ručno dodane stavke.
// Kod ručnog obračuna (billing_mode = 'manual') treninzi iz rasporeda se ne obračunavaju,
// nego samo članarina i ručno unesene stavke.
// Samo informativno – nikakvo plaćanje se ne vrši.
function monthlyStatement(db, user, month) {
  const { first, last } = monthRange(month);
  const manual = user.billing_mode === 'manual';
  const lessons = manual ? [] : db
    .prepare(
      `SELECT * FROM lessons
        WHERE user_id = ? AND date BETWEEN ? AND ?
        ORDER BY date, start_time`
    )
    .all(user.id, first, last);
  const adjustments = db
    .prepare('SELECT * FROM adjustments WHERE user_id = ? AND month = ? ORDER BY id')
    .all(user.id, month);

  const billed = lessons.filter((l) => !l.cancelled);
  const lessonsTotal = billed.reduce((sum, l) => sum + l.price_cents, 0);
  const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount_cents, 0);
  const minutes = billed.reduce((sum, l) => sum + l.duration_min, 0);
  const fee = user.monthly_fee_cents || 0;

  return {
    month,
    manual,
    lessons,
    adjustments,
    fee,
    lessonCount: billed.length,
    hours: minutes / 60,
    lessonsTotal,
    adjustmentsTotal,
    total: fee + lessonsTotal + adjustmentsTotal,
  };
}

function formatHours(hours) {
  return `${hours.toLocaleString('bs-BA', { maximumFractionDigits: 2 })} h`;
}

module.exports = { monthlyStatement, formatHours };
