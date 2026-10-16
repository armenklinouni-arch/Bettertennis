'use strict';

// Roditeljski račun (Elternkonto): isključivo čitanje. Vidi samo igrače koje mu je admin dodijelio –
// njihov zajednički sedmični raspored i mjesečne iznose, s izborom igrača za zbir.
// Izbor igrača se nigdje ne čuva: dolazi samo iz URL-a i za svaki mjesec se može slobodno mijenjati.
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { monthlyStatement, formatHours } = require('../billing');
const { layout, weekView, monthNav, paymentBadge } = require('../views');
const { requireParentAccount } = require('../auth');
const { isWeekReleased } = require('../weeks');

module.exports = function parentPortalRoutes(db) {
  const router = express.Router();
  router.use(requireParentAccount);

  // Svi upiti su vezani za parent_account_id prijavljenog računa – tuđi igrači se nikad ne učitavaju.
  const myPlayers = db.prepare(
    `SELECT u.* FROM parent_account_players p JOIN users u ON u.id = p.user_id
      WHERE p.parent_account_id = ? AND u.role = 'member'
      ORDER BY u.name COLLATE NOCASE, u.id`
  );
  const playerLessons = db.prepare(
    // Bez imena trenera – kao i kod članova.
    `SELECT l.*, u.name AS member_name FROM lessons l
       JOIN users u ON u.id = l.user_id
       JOIN parent_account_players p ON p.user_id = l.user_id AND p.parent_account_id = ?
      WHERE l.date BETWEEN ? AND ?
      ORDER BY l.date, l.start_time, u.name COLLATE NOCASE`
  );

  // Zajednički sedmični raspored svih dodijeljenih igrača (samo objavljene sedmice).
  router.get('/', (req, res) => {
    const today = D.todayISO();
    const requested = D.isValidDate(req.query.woche) ? req.query.woche : today;
    const monday = D.mondayOf(requested);
    const players = myPlayers.all(req.user.id);
    const released = isWeekReleased(db, monday);
    const lessons = released ? playerLessons.all(req.user.id, monday, D.addDays(monday, 6)) : [];
    const minutes = lessons.filter((l) => !l.cancelled).reduce((s, l) => s + l.duration_min, 0);

    res.send(String(layout(req, {
      title: 'Sedmični raspored',
      wide: true,
      body: html`
      <div class="page-head">
        <div>
          <h1>Zdravo, ${req.user.name}!</h1>
          <p class="muted">Treninzi ove sedmice: ${lessons.filter((l) => !l.cancelled).length} (${formatHours(minutes / 60)})
            · Igrači: ${players.length ? players.map((p) => p.name).join(', ') : '–'}</p>
        </div>
      </div>
      ${released ? '' : html`<p class="notice">Raspored za ovu sedmicu još nije objavljen. Bit će vidljiv čim ga teniska škola objavi.</p>`}
      ${weekView({ monday, lessons, baseUrl: '/roditelj', today })}`,
    })));
  });

  // Mjesečni iznosi: igrač(i) po izboru, zbir se računa uživo za odabrani mjesec.
  router.get('/finansije', (req, res) => {
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const players = myPlayers.all(req.user.id);
    const allowed = new Set(players.map((p) => p.id));
    let selected;
    if (req.query.izbor === '1') {
      const raw = [].concat(req.query.igraci || []);
      // Samo dodijeljeni igrači – tuđi ID-jevi se ignorišu.
      selected = new Set(raw.map(Number).filter((id) => allowed.has(id)));
    } else {
      selected = new Set(allowed);
    }
    const rows = players.map((p) => ({ player: p, st: monthlyStatement(db, p, month), on: selected.has(p.id) }));
    // Član vidi iznos tek kad ga škola odobri – isto važi i za roditeljski račun.
    const counted = rows.filter((r) => r.on && r.st.released);
    const total = counted.reduce((s, r) => s + r.st.total, 0);
    const pendingSelected = rows.filter((r) => r.on && !r.st.released);
    const selectionQuery = `&izbor=1${[...selected].map((id) => `&igraci=${id}`).join('')}`;

    res.send(String(layout(req, {
      title: 'Finansije',
      body: html`
      <div class="page-head"><div>
        <h1>Finansije</h1>
        <p class="muted">Mjesečni iznosi tvojih igrača. Označi igrače koje želiš uključiti – zbir se odmah računa
          za odabrani mjesec. Izbor se ne čuva i možeš ga u svakom mjesecu slobodno mijenjati.</p>
      </div></div>
      ${monthNav('/roditelj/finansije', month, selectionQuery)}
      <div class="summary-tile big">
        <span class="label">Ukupno za odabrane igrače · ${D.monthLabel(month)}</span>
        <span class="value" data-total="${total}">${formatMoney(total)}</span>
        <span class="hint">${selected.size === 0
          ? 'Nijedan igrač nije odabran.'
          : `Odabrano: ${counted.length + pendingSelected.length} od ${players.length}`}${
          pendingSelected.length ? ` · ${pendingSelected.length} u pripremi (nije uključeno u zbir)` : ''}</span>
      </div>
      <section class="card">
        <form method="get" action="/roditelj/finansije" class="stack" data-autosubmit>
          <input type="hidden" name="monat" value="${month}">
          <input type="hidden" name="izbor" value="1">
          <div class="table-wrap"><table>
            <thead><tr><th>Uključi</th><th>Igrač</th><th class="num">Termini</th><th class="num">Iznos</th><th>Status</th></tr></thead>
            <tbody>${players.length === 0
              ? html`<tr><td colspan="5" class="empty">Još nema dodijeljenih igrača.</td></tr>`
              : rows.map(({ player, st, on }) => html`<tr class="${on ? 'is-selected' : ''}">
                <td><label class="check"><input type="checkbox" name="igraci" value="${player.id}"${on ? ' checked' : ''}><span class="sr-only">Uključi ${player.name}</span></label></td>
                <td><strong>${player.name}</strong></td>
                <td class="num">${st.manual ? '–' : st.lessonCount}</td>
                <td class="num">${st.released ? formatMoney(st.total) : '–'}</td>
                <td>${st.released ? paymentBadge(st) : html`<span class="tag tag-pending">Obračun u pripremi</span>`}</td>
              </tr>`)}</tbody>
          </table></div>
          <div class="btn-row"><button class="btn btn-primary btn-sm" type="submit">Izračunaj zbir</button></div>
        </form>
      </section>
      <p class="muted small">Pregled je samo informativan. Iznos mjeseca je vidljiv kad ga škola odobri.</p>`,
    })));
  });

  return router;
};
