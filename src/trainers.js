'use strict';

const { monthRange } = require('./dates');

// Isplata trenera: po satu, s različitom satnicom za individualni i grupni trening.
// Računaju se samo „Realizovan“ termini; grupni trening se računa jednom po terminu
// (ne po članu). Uz to se mogu dodati dodatne isplate (npr. nagrada, bonus).

function trainerPay(trainer, kind, durationMin) {
  const rate = kind === 'group' ? trainer.rate_group_cents : trainer.rate_individual_cents;
  return Math.round(((rate || 0) * durationMin) / 60);
}

// Termini trenera u periodu, grupni treninzi spojeni u jedan termin (s listom članova).
function trainerSessionsBetween(db, trainer, from, to, { includeCancelled = false } = {}) {
  const rows = db
    .prepare(
      `SELECT l.*, u.name AS member_name FROM lessons l JOIN users u ON u.id = l.user_id
        WHERE l.trainer_id = ? AND l.date BETWEEN ? AND ? ${includeCancelled ? '' : 'AND l.cancelled = 0'}
        ORDER BY l.date, l.start_time, l.id`
    )
    .all(trainer.id, from, to);
  const sessions = [];
  const byGroup = new Map();
  for (const r of rows) {
    const existing = r.group_id && byGroup.get(r.group_id);
    if (existing) {
      existing.members.push(r.member_name);
      existing.value_cents += r.price_cents;
      continue;
    }
    const session = {
      id: r.id,
      date: r.date,
      start_time: r.start_time,
      duration_min: r.duration_min,
      court: r.court,
      kind: r.kind,
      cancelled: r.cancelled,
      note: r.note,
      members: [r.member_name],
      value_cents: r.price_cents,
      pay_cents: trainerPay(trainer, r.kind, r.duration_min),
    };
    if (r.group_id) byGroup.set(r.group_id, session);
    sessions.push(session);
  }
  return sessions;
}

// Realizovani termini trenera u mjesecu.
function trainerSessions(db, trainer, month) {
  const { first, last } = monthRange(month);
  return trainerSessionsBetween(db, trainer, first, last);
}

// Ukupno od početka (od prvog termina) do zadanog datuma: broj termina i sati po vrsti.
function trainerTotalsUntil(db, trainer, until) {
  const sessions = trainerSessionsBetween(db, trainer, '0000-01-01', until);
  const totals = { individual: emptyTotals(), group: emptyTotals(), first: sessions.length ? sessions[0].date : null };
  for (const s of sessions) {
    const t = s.kind === 'group' ? totals.group : totals.individual;
    t.count += 1;
    t.minutes += s.duration_min;
    t.pay += s.pay_cents;
  }
  return totals;
}

function emptyTotals() {
  return { count: 0, minutes: 0, pay: 0, value: 0 };
}

// Mjesečni izvještaj za jednog trenera.
function trainerReport(db, trainer, month) {
  const sessions = trainerSessions(db, trainer, month);
  const individual = emptyTotals();
  const group = emptyTotals();
  for (const s of sessions) {
    const t = s.kind === 'group' ? group : individual;
    t.count += 1;
    t.minutes += s.duration_min;
    t.pay += s.pay_cents;
    t.value += s.value_cents;
  }
  const bonuses = db
    .prepare('SELECT * FROM trainer_bonuses WHERE trainer_id = ? AND month = ? ORDER BY id')
    .all(trainer.id, month);
  const bonusTotal = bonuses.reduce((sum, b) => sum + b.amount_cents, 0);
  const payTotal = individual.pay + group.pay + bonusTotal;
  const valueTotal = individual.value + group.value;
  return {
    month,
    sessions,
    individual,
    group,
    bonuses,
    bonusTotal,
    payTotal,
    valueTotal,
    // Razlika: vrijednost treninga po cijenama članova minus isplata treneru.
    margin: valueTotal - payTotal,
  };
}

module.exports = { trainerPay, trainerSessions, trainerSessionsBetween, trainerTotalsUntil, trainerReport };
