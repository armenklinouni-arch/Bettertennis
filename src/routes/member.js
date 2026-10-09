'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatEUR } = require('../money');
const { monthlyStatement, formatHours } = require('../billing');
const { layout, csrfField, errorList, weekView, statementTable, monthNav, lessonTimeRange } = require('../views');
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

  // Wochenplan Montag–Sonntag
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
      title: 'Mein Wochenplan',
      wide: true,
      body: html`
      <div class="page-head">
        <div>
          <h1>Hallo ${req.user.name}!</h1>
          <p class="muted">Deine Trainingseinheiten in dieser Woche: ${lessons.filter((l) => !l.cancelled).length}
            (${formatHours(weekMinutes / 60)})</p>
        </div>
        <a class="summary-tile" href="/mitglied/abrechnung?monat=${month}">
          <span class="label">Voraussichtlicher Betrag ${D.monthLabel(month)}</span>
          <span class="value">${formatEUR(statement.total)}</span>
          <span class="hint">${statement.lessonCount} Termine · nur zur Information</span>
        </a>
      </div>
      ${weekView({ monday, lessons, baseUrl: '/mitglied', today })}
      <section class="card">
        <h2>Nächste Termine</h2>
        ${upcoming.length === 0
          ? html`<p class="muted">Aktuell sind keine weiteren Termine geplant.</p>`
          : html`<ul class="list">${upcoming.map(
              (l) => html`<li><strong>${D.formatDateLong(l.date)}</strong> · ${lessonTimeRange(l)} Uhr
                ${l.court ? html`· Platz ${l.court}` : ''} — ${req.user.name}</li>`
            )}</ul>`}
      </section>`,
    })));
  });

  // Monatsbetrag (nur Information, keine Zahlungsfunktion)
  router.get('/abrechnung', (req, res) => {
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const statement = monthlyStatement(db, req.user, month);
    res.send(String(layout(req, {
      title: 'Monatsbetrag',
      body: html`
      <div class="page-head">
        <div>
          <h1>Monatsbetrag</h1>
          <p class="muted">Übersicht der Kosten für ${D.monthLabel(month)}. Diese Aufstellung dient nur zur Information –
            die Bezahlung erfolgt wie mit deiner Tennisschule vereinbart.</p>
        </div>
      </div>
      ${monthNav('/mitglied/abrechnung', month)}
      <div class="summary-tile big">
        <span class="label">Am Monatsende zu zahlen</span>
        <span class="value">${formatEUR(statement.total)}</span>
        <span class="hint">${statement.lessonCount} Termine · ${formatHours(statement.hours)}${
          req.user.hourly_rate_cents ? ` · ${formatEUR(req.user.hourly_rate_cents)} pro Stunde` : ''}</span>
      </div>
      ${statementTable(statement)}`,
    })));
  });

  function passwordPage(req, errors = []) {
    return layout(req, {
      title: 'Passwort ändern',
      body: html`
      <section class="card narrow">
        <h1>Passwort ändern</h1>
        ${errorList(errors)}
        <form method="post" action="/mitglied/passwort" class="stack">
          ${csrfField(req)}
          <label>Aktuelles Passwort
            <input name="current" type="password" required autocomplete="current-password">
          </label>
          <label>Neues Passwort (mind. 8 Zeichen)
            <input name="password" type="password" required minlength="8" autocomplete="new-password">
          </label>
          <label>Neues Passwort wiederholen
            <input name="password2" type="password" required minlength="8" autocomplete="new-password">
          </label>
          <button class="btn btn-primary" type="submit">Speichern</button>
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
    if (!verifyPassword(current, req.user.password_hash)) errors.push('Das aktuelle Passwort ist falsch.');
    if (typeof password !== 'string' || password.length < 8) errors.push('Das neue Passwort muss mindestens 8 Zeichen haben.');
    if (password !== password2) errors.push('Die neuen Passwörter stimmen nicht überein.');
    if (errors.length) {
      res.status(400);
      return res.send(String(passwordPage(req, errors)));
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
    res.flash('success', 'Dein Passwort wurde geändert.');
    res.redirect(req.user.role === 'admin' ? '/admin' : '/mitglied');
  });

  return router;
};
