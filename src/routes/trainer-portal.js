'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { formatHours } = require('../billing');
const { trainerReport, trainerSessionsBetween, trainerTotalsUntil } = require('../trainers');
const { layout, csrfField, errorList, weekView, monthNav, lessonTimeRange, LESSON_KINDS } = require('../views');
const { requireTrainer, hashPassword, verifyPassword } = require('../auth');

// Trenerski dio: svaki trener vidi samo svoje termine, svoje igrače i svoju isplatu.
// Cijene članova i podaci drugih trenera ovdje se nikad ne prikazuju.
module.exports = function trainerPortalRoutes(db) {
  const router = express.Router();
  router.use(requireTrainer);

  function playersLabel(session) {
    return `${session.members.length} ${session.members.length === 1 ? 'igrač' : 'igrača'}`;
  }

  // ---------------------------------------------------------------- Mjesečni izvještaj
  router.get('/', (req, res) => {
    const trainer = req.user;
    const today = D.todayISO();
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(today);
    const r = trainerReport(db, trainer, month);
    const total = trainerTotalsUntil(db, trainer, today);
    const totalMinutes = total.individual.minutes + total.group.minutes;
    const totalCount = total.individual.count + total.group.count;

    res.send(String(layout(req, {
      title: 'Moj izvještaj',
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>Zdravo, ${trainer.name}!</h1>
        <p class="muted">Tvoji treninzi i isplata. Računaju se samo termini sa statusom „Realizovan“.</p>
      </div></div>

      <section class="card">
        <h2>Ukupno do danas</h2>
        <div class="tiles">
          <div class="summary-tile"><span class="label">Ukupno sati</span><span class="value">${formatHours(totalMinutes / 60)}</span>
            <span class="hint">${totalCount} treninga${total.first ? ` od ${D.formatDate(total.first)}` : ''}</span></div>
          <div class="summary-tile"><span class="label">Individualni treninzi</span><span class="value">${total.individual.count}</span>
            <span class="hint">${formatHours(total.individual.minutes / 60)}</span></div>
          <div class="summary-tile"><span class="label">Grupni treninzi</span><span class="value">${total.group.count}</span>
            <span class="hint">${formatHours(total.group.minutes / 60)}</span></div>
        </div>
      </section>

      <h2>Mjesečni izvještaj</h2>
      ${monthNav('/trener', month)}
      <div class="tiles">
        <div class="summary-tile"><span class="label">Individualni treninzi</span><span class="value">${r.individual.count}</span>
          <span class="hint">${formatHours(r.individual.minutes / 60)} · ${formatMoney(r.individual.pay)}</span></div>
        <div class="summary-tile"><span class="label">Grupni treninzi</span><span class="value">${r.group.count}</span>
          <span class="hint">${formatHours(r.group.minutes / 60)} · ${formatMoney(r.group.pay)}</span></div>
        <div class="summary-tile"><span class="label">Dodatno</span><span class="value">${formatMoney(r.bonusTotal)}</span>
          <span class="hint">${r.bonuses.map((b) => b.description).join(', ') || 'nema'}</span></div>
        <div class="summary-tile big"><span class="label">Ukupno za ${D.monthLabel(month)}</span><span class="value">${formatMoney(r.payTotal)}</span>
          <span class="hint">${formatHours((r.individual.minutes + r.group.minutes) / 60)} ukupno</span></div>
      </div>

      <section class="card">
        <h2>Treninzi u mjesecu (${r.sessions.length})</h2>
        ${r.sessions.length === 0
          ? html`<p class="muted">U ovom mjesecu nemaš treninga.</p>`
          : html`<div class="table-wrap"><table>
            <thead><tr><th>Datum</th><th>Vrijeme</th><th>Vrsta</th><th>Igrači</th><th class="num">Trajanje</th><th class="num">Isplata</th></tr></thead>
            <tbody>${r.sessions.map((s) => html`
              <tr>
                <td>${D.formatDateLong(s.date)}${s.date > today ? html` <span class="tag">planiran</span>` : ''}</td>
                <td>${lessonTimeRange(s)} h${s.court ? ` · Teren ${s.court}` : ''}</td>
                <td><span class="tag tag-kind${s.kind === 'group' ? ' is-group' : ''}">${LESSON_KINDS[s.kind]}</span></td>
                <td><strong>${playersLabel(s)}:</strong> ${s.members.join(', ')}</td>
                <td class="num">${s.duration_min} min</td>
                <td class="num">${formatMoney(s.pay_cents)}</td>
              </tr>`)}</tbody>
            <tfoot><tr class="total"><td colspan="4">Ukupno treninzi</td>
              <td class="num">${formatHours((r.individual.minutes + r.group.minutes) / 60)}</td>
              <td class="num">${formatMoney(r.individual.pay + r.group.pay)}</td></tr></tfoot>
          </table></div>`}
        <p class="muted small">Izvještaj je informativan. Termini označeni kao „planiran“ su u budućnosti.</p>
      </section>`,
    })));
  });

  // ---------------------------------------------------------------- Sedmični raspored trenera
  router.get('/raspored', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(D.isValidDate(req.query.woche) ? req.query.woche : today);
    const sessions = trainerSessionsBetween(db, req.user, monday, D.addDays(monday, 6), { includeCancelled: true });
    const lessons = sessions.map((s) => ({ ...s, member_name: `${s.members.join(', ')} (${playersLabel(s)})` }));
    res.send(String(layout(req, {
      title: 'Moj raspored',
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>Moj raspored</h1>
        <p class="muted">Tvoji termini od ponedjeljka do nedjelje, s igračima u svakoj grupi.</p>
      </div></div>
      ${weekView({ monday, lessons, baseUrl: '/trener/raspored', today })}`,
    })));
  });

  // ---------------------------------------------------------------- Lozinka
  function passwordPage(req, errors = []) {
    return layout(req, {
      title: 'Promjena lozinke',
      body: html`
      <section class="card narrow">
        <h1>Promjena lozinke</h1>
        ${errorList(errors)}
        <form method="post" action="/trener/lozinka" class="stack">
          ${csrfField(req)}
          <label>Trenutna lozinka<input name="current" type="password" required autocomplete="current-password"></label>
          <label>Nova lozinka (najmanje 8 znakova)<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label>Ponovi novu lozinku<input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
          <button class="btn btn-primary" type="submit">Sačuvaj</button>
        </form>
      </section>`,
    });
  }

  router.get('/lozinka', (req, res) => {
    res.send(String(passwordPage(req)));
  });

  router.post('/lozinka', (req, res) => {
    const { current = '', password = '', password2 = '' } = req.body;
    const errors = [];
    if (!verifyPassword(current, req.user.password_hash)) errors.push('Trenutna lozinka nije ispravna.');
    if (typeof password !== 'string' || password.length < 8) errors.push('Nova lozinka mora imati najmanje 8 znakova.');
    if (password !== password2) errors.push('Nove lozinke se ne podudaraju.');
    if (errors.length) {
      res.status(400);
      return res.send(String(passwordPage(req, errors)));
    }
    db.prepare('UPDATE trainers SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.trainer_id);
    res.flash('success', 'Tvoja lozinka je promijenjena.');
    res.redirect('/trener');
  });

  return router;
};
