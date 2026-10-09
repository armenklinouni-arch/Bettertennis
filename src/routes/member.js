'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { monthlyStatement, formatHours } = require('../billing');
const { layout, csrfField, errorList, weekView, statementTable, monthNav, lessonTimeRange, lessonKindLabel } = require('../views');
const { requireLogin, hashPassword, verifyPassword } = require('../auth');

module.exports = function memberRoutes(db) {
  const router = express.Router();
  router.use(requireLogin);

  const weekLessons = db.prepare(
    `SELECT l.*, u.name AS member_name FROM lessons l JOIN users u ON u.id = l.user_id
      WHERE l.user_id = ? AND l.date BETWEEN ? AND ?
      ORDER BY l.date, l.start_time`
  );
  const upcomingLessons = db.prepare(
    `SELECT * FROM lessons WHERE user_id = ? AND date >= ? AND cancelled = 0
      ORDER BY date, start_time LIMIT 5`
  );

  // Sedmični raspored ponedjeljak–nedjelja
  router.get('/', (req, res) => {
    const today = D.todayISO();
    const requested = D.isValidDate(req.query.woche) ? req.query.woche : today;
    const monday = D.mondayOf(requested);
    const lessons = weekLessons.all(req.user.id, monday, D.addDays(monday, 6));
    const month = D.monthOf(today);
    const statement = monthlyStatement(db, req.user, month);
    const upcoming = upcomingLessons.all(req.user.id, today);
    const weekMinutes = lessons.filter((l) => !l.cancelled).reduce((s, l) => s + l.duration_min, 0);

    res.send(String(layout(req, {
      title: 'Moj sedmični raspored',
      wide: true,
      body: html`
      <div class="page-head">
        <div>
          <h1>Zdravo, ${req.user.name}!</h1>
          <p class="muted">Tvoji treninzi ove sedmice: ${lessons.filter((l) => !l.cancelled).length}
            (${formatHours(weekMinutes / 60)})</p>
        </div>
        <a class="summary-tile" href="/mitglied/abrechnung?monat=${month}">
          <span class="label">Očekivani iznos za ${D.monthLabel(month)}</span>
          <span class="value">${formatMoney(statement.total)}</span>
          <span class="hint">${statement.manual ? 'Ručni obračun' : `Termini: ${statement.lessonCount}`} · samo informativno</span>
        </a>
      </div>
      ${weekView({ monday, lessons, baseUrl: '/mitglied', today })}
      <section class="card">
        <h2>Sljedeći termini</h2>
        ${upcoming.length === 0
          ? html`<p class="muted">Trenutno nema planiranih termina.</p>`
          : html`<ul class="list">${upcoming.map(
              (l) => html`<li><strong>${D.formatDateLong(l.date)}</strong> · ${lessonTimeRange(l)} h
                ${l.court ? html`· Teren ${l.court}` : ''} · ${lessonKindLabel(l)} — ${req.user.name}</li>`
            )}</ul>`}
      </section>`,
    })));
  });

  // Mjesečni iznos (samo informativno, bez funkcije plaćanja)
  router.get('/abrechnung', (req, res) => {
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const statement = monthlyStatement(db, req.user, month);
    res.send(String(layout(req, {
      title: 'Mjesečni iznos',
      body: html`
      <div class="page-head">
        <div>
          <h1>Mjesečni iznos</h1>
          <p class="muted">Pregled troškova za ${D.monthLabel(month)}. Ovaj pregled je samo informativan –
            plaćanje se vrši kako je dogovoreno s tvojom teniskom školom.</p>
        </div>
      </div>
      ${monthNav('/mitglied/abrechnung', month)}
      <div class="summary-tile big">
        <span class="label">Za platiti na kraju mjeseca</span>
        <span class="value">${formatMoney(statement.total)}</span>
        <span class="hint">${statement.manual ? 'Ručni obračun' : `Termini: ${statement.lessonCount} · ${formatHours(statement.hours)}`}${
          req.user.hourly_rate_cents ? ` · ${formatMoney(req.user.hourly_rate_cents)} po satu` : ''}</span>
      </div>
      ${statementTable(statement)}`,
    })));
  });

  function passwordPage(req, errors = []) {
    return layout(req, {
      title: 'Promjena lozinke',
      body: html`
      <section class="card narrow">
        <h1>Promjena lozinke</h1>
        ${errorList(errors)}
        <form method="post" action="/mitglied/passwort" class="stack">
          ${csrfField(req)}
          <label>Trenutna lozinka
            <input name="current" type="password" required autocomplete="current-password">
          </label>
          <label>Nova lozinka (najmanje 8 znakova)
            <input name="password" type="password" required minlength="8" autocomplete="new-password">
          </label>
          <label>Ponovi novu lozinku
            <input name="password2" type="password" required minlength="8" autocomplete="new-password">
          </label>
          <button class="btn btn-primary" type="submit">Sačuvaj</button>
        </form>
      </section>`,
    });
  }

  router.get('/passwort', (req, res) => {
    res.send(String(passwordPage(req)));
  });

  router.post('/passwort', (req, res) => {
    const { current = '', password = '', password2 = '' } = req.body;
    const errors = [];
    if (!verifyPassword(current, req.user.password_hash)) errors.push('Trenutna lozinka nije ispravna.');
    if (typeof password !== 'string' || password.length < 8) errors.push('Nova lozinka mora imati najmanje 8 znakova.');
    if (password !== password2) errors.push('Nove lozinke se ne podudaraju.');
    if (errors.length) {
      res.status(400);
      return res.send(String(passwordPage(req, errors)));
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
    res.flash('success', 'Tvoja lozinka je promijenjena.');
    res.redirect(req.user.role === 'admin' ? '/admin' : '/mitglied');
  });

  return router;
};
