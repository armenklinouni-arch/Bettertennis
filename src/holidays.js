'use strict';

// Praznici / dani bez treninga: samo oznaka u sedmičnom rasporedu (Map datum → naziv).
// Ne mijenja termine, obračun ni prisustvo i ne šalje e-mailove.
function holidaysBetween(db, from, to) {
  const rows = db.prepare('SELECT date, name FROM holidays WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to);
  return new Map(rows.map((r) => [r.date, r.name]));
}

module.exports = { holidaysBetween };
