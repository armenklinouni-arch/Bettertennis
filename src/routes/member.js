'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { monthlyStatement, formatHours, memberMonthRange, MEMBER_MONTHS_BACK } = require('../billing');
const {
  layout, csrfField, errorList, weekView, statementTable, monthNav, paymentBadge, lessonTimeRange, lessonKindLabel,
} = require('../views');
const { requireLogin, hashPassword, verifyPassword } = require('../auth');

module.exports = function memberRoutes(db) {
  const router = express.Router();
  router.use(requireLogin);

  const weekLessons = db.prepare(
    `SELECT l.*, u.name AS member_name, t.name AS trainer_name FROM lessons l
       JOIN users u ON u.id = l.user_id LEFT JOIN trainers t ON t.id = l.trainer_id
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
          <span class="hint">${statement.manual ? 'Ručni obračun' : `Termini: ${statement.lessonCount}`} · ${paymentBadge(statement)}</span>
        </a>
      </div>
      ${req.unreadNews
        ? html`<a class="notice notice-link" href="/mitglied/aktuelnosti">📬 Imaš nepročitane aktuelnosti: <strong>${req.unreadNews}</strong> – otvori sandučić →</a>`
        : ''}
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

  // Mjesečni iznos (samo informativno, bez funkcije plaćanja).
  // Članovi vide samo tekući mjesec i tri mjeseca unazad.
  router.get('/abrechnung', (req, res) => {
    const { min, max } = memberMonthRange();
    let month = D.isValidMonth(req.query.monat) ? req.query.monat : max;
    if (month < min) month = min;
    if (month > max) month = max;
    const statement = monthlyStatement(db, req.user, month);
    const history = [];
    for (let m = max; m >= min; m = D.addMonths(m, -1)) history.push(monthlyStatement(db, req.user, m));
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
      ${monthNav('/mitglied/abrechnung', month, '', { min, max })}
      <div class="summary-tile big">
        <span class="label">${statement.paid ? 'Iznos za mjesec' : 'Za platiti na kraju mjeseca'} · ${paymentBadge(statement)}</span>
        <span class="value">${formatMoney(statement.total)}</span>
        <span class="hint">${statement.manual ? 'Ručni obračun' : `Termini: ${statement.lessonCount} · ${formatHours(statement.hours)}`}${
          req.user.hourly_rate_cents ? ` · ${formatMoney(req.user.hourly_rate_cents)} po satu` : ''}</span>
      </div>
      ${statementTable(statement)}
      <section class="card">
        <h2>Pregled plaćanja</h2>
        <p class="muted small">Prikazan je tekući mjesec i ${MEMBER_MONTHS_BACK} mjeseca unazad.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Mjesec</th><th class="num">Iznos</th><th>Status</th></tr></thead>
            <tbody>${history.map((h) => html`
              <tr${h.month === month ? html` class="is-selected"` : ''}>
                <td><a href="/mitglied/abrechnung?monat=${h.month}">${D.monthLabel(h.month)}</a></td>
                <td class="num">${formatMoney(h.total)}</td>
                <td>${paymentBadge(h)}</td>
              </tr>`)}</tbody>
          </table>
        </div>
      </section>`,
    })));
  });

  // ---------------------------------------------------------------- Aktuelnosti (sandučić)
  const myNews = db.prepare(
    `SELECT n.*, r.read_at FROM news n JOIN news_recipients r ON r.news_id = n.id
      WHERE r.user_id = ? ORDER BY n.created_at DESC, n.id DESC`
  );
  const oneNews = db.prepare(
    `SELECT n.*, r.read_at FROM news n JOIN news_recipients r ON r.news_id = n.id
      WHERE r.user_id = ? AND n.id = ?`
  );

  router.get('/aktuelnosti', (req, res) => {
    const items = myNews.all(req.user.id);
    res.send(String(layout(req, {
      title: 'Aktuelnosti',
      body: html`
      <div class="page-head"><div>
        <h1>Aktuelnosti</h1>
        <p class="muted">Novosti iz teniske škole: turniri, aktivnosti i obavještenja.</p>
      </div></div>
      ${items.length === 0
        ? html`<p class="card muted">Sandučić je prazan – još nema aktuelnosti.</p>`
        : html`<ul class="inbox">${items.map((n) => html`
            <li class="${n.read_at ? '' : 'is-unread'}">
              <a href="/mitglied/aktuelnosti/${n.id}">
                <span class="inbox-title">${n.read_at ? '' : html`<span class="dot" aria-label="nepročitano"></span>`}${n.title}</span>
                <span class="inbox-date">${D.formatDate(n.created_at.slice(0, 10))}</span>
                <span class="inbox-preview">${n.body.length > 140 ? `${n.body.slice(0, 140)}…` : n.body}</span>
              </a>
            </li>`)}</ul>`}`,
    })));
  });

  router.get('/aktuelnosti/:id', (req, res) => {
    const id = Number(req.params.id);
    const item = Number.isInteger(id) ? oneNews.get(req.user.id, id) : null;
    if (!item) return res.status(404).send('Nije pronađeno: aktuelnost.');
    if (!item.read_at) {
      db.prepare("UPDATE news_recipients SET read_at = datetime('now') WHERE news_id = ? AND user_id = ?").run(item.id, req.user.id);
      req.unreadNews = Math.max(0, req.unreadNews - 1);
    }
    res.send(String(layout(req, {
      title: item.title,
      body: html`
      <a class="btn btn-ghost btn-sm" href="/mitglied/aktuelnosti">← Nazad na aktuelnosti</a>
      <article class="card news-article">
        <p class="muted small">${D.formatDateLong(item.created_at.slice(0, 10))}</p>
        <h1>${item.title}</h1>
        <div class="pre">${item.body}</div>
      </article>`,
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
