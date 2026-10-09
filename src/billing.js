'use strict';

const { monthRange } = require('./dates');

// Monatsübersicht eines Mitglieds: Grundgebühr + nicht abgesagte Trainings + manuelle Posten.
// Reine Information – es findet keine Zahlung statt.
function monthlyStatement(db, user, month) {
  const { first, last } = monthRange(month);
  const lessons = db
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
  return `${hours.toLocaleString('de-DE', { maximumFractionDigits: 2 })} Std.`;
}

module.exports = { monthlyStatement, formatHours };
