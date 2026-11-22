'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { monthlyStatement, formatHours, memberMonthRange, MEMBER_MONTHS_BACK } = require('../billing');
const {
  layout, csrfField, errorList, weekView, statementTable, monthNav, paymentBadge, lessonTimeRange, lessonKindLabel,
} = require('../views');
const { requireMember, hashPassword, verifyPassword, endSessionsFor } = require('../auth');
const { isWeekReleased } = require('../weeks');
const {
  USERNAME_RE, normalizeUsername, usernameTaken, placeholderEmail, isPlaceholderEmail, CHILDREN_LIMIT,
} = require('../db');
const { EMAIL_RE } = require('./public');
const { logActivity, changes } = require('../activity');
const { recordView } = require('../page-views');
const { holidaysBetween } = require('../holidays');
const {
  isSlotOpen, slotStartMs, slotLabel, formatSarajevo, NOTIFY_EMAIL_DEFAULT,
} = require('../private-lessons');


function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

module.exports = function memberRoutes(db, { mailer = null, notifyEmail = NOTIFY_EMAIL_DEFAULT } = {}) {
  const router = express.Router();
  router.use(requireMember);

  // Dječiji račun (kreirao ga je roditelj) smije vidjeti samo svoj sedmični raspored –
  // nikakve iznose, plaćanja, obračune, aktuelnosti ni postavke.
  router.use((req, res, next) => {
    if (req.user.parent_id && !(req.method === 'GET' && req.path === '/')) {
      res.status(403);
      return res.send(req.t('err.childOnly'));
    }
    next();
  });

  const weekLessons = db.prepare(
    // Namjerno bez imena trenera: članovi ne smiju vidjeti koji trener radi s njima.
    `SELECT l.*, u.name AS member_name FROM lessons l
       JOIN users u ON u.id = l.user_id
      WHERE l.user_id IN (?, ?) AND l.date BETWEEN ? AND ?
      ORDER BY l.date, l.start_time`
  );
  const upcomingLessons = db.prepare(
    `SELECT * FROM lessons WHERE user_id IN (?, ?) AND date >= ? AND cancelled = 0
      ORDER BY date, start_time LIMIT 200`
  );
  // Dječiji račun prikazuje termine svog člana (roditeljskog računa) – i eventualne starije termine
  // koji su direktno upisani na dječiji račun. Član vidi samo svoje termine.
  const scheduleIds = (user) => (user.parent_id ? [user.id, user.parent_id] : [user.id, user.id]);
  // Članovi i djeca vide samo termine iz objavljenih sedmica.
  const visibleOnly = (lessons) => {
    const cache = new Map();
    return lessons.filter((l) => {
      const monday = D.mondayOf(l.date);
      if (!cache.has(monday)) cache.set(monday, isWeekReleased(db, monday));
      return cache.get(monday);
    });
  };

  // Sedmični raspored ponedjeljak–nedjelja
  router.get('/', (req, res) => {
    const today = D.todayISO();
    const requested = D.isValidDate(req.query.woche) ? req.query.woche : today;
    const monday = D.mondayOf(requested);
    const weekReleased = isWeekReleased(db, monday);
    const lessons = weekReleased ? weekLessons.all(...scheduleIds(req.user), monday, D.addDays(monday, 6)) : [];
    const month = D.monthOf(today);
    const isChild = !!req.user.parent_id;
    const statement = isChild ? null : monthlyStatement(db, req.user, month);
    const upcoming = visibleOnly(upcomingLessons.all(...scheduleIds(req.user), today)).slice(0, 5);
    const emailPrompt = takeEmailPrompt(req, res);
    const weekMinutes = lessons.filter((l) => !l.cancelled).reduce((s, l) => s + l.duration_min, 0);
    const { t, lang } = req;
    // „Ko je pogledao“: samo objavljena sedmica (dječiji račun se računa kod svog člana).
    if (weekReleased) {
      recordView(db, {
        kind: 'raspored', period: monday, viewerType: isChild ? 'dijete' : 'clan', viewerId: req.user.id,
        playerIds: isChild ? [req.user.parent_id, ...(lessons.some((l) => l.user_id === req.user.id) ? [req.user.id] : [])] : [req.user.id],
      });
    }

    res.send(String(layout(req, {
      title: t('m.weekTitle'),
      wide: true,
      body: html`
      <div class="page-head">
        <div>
          <h1>${t('hello', { name: req.user.name })}</h1>
          <p class="muted">${t('m.weekCount', { n: lessons.filter((l) => !l.cancelled).length, hours: formatHours(weekMinutes / 60, lang) })}</p>
        </div>
        ${isChild ? '' : statement.released
          ? html`<a class="summary-tile" href="/mitglied/abrechnung?monat=${month}">
              <span class="label">${t('m.amountFor', { month: D.monthLabel(month, lang) })}</span>
              <span class="value">${formatMoney(statement.total)}</span>
              <span class="hint">${statement.manual ? '' : t('m.termsPrefix', { n: statement.lessonCount })}${paymentBadge(statement, { lang })}</span>
            </a>`
          : html`<a class="summary-tile" href="/mitglied/abrechnung?monat=${month}">
              <span class="label">${t('m.amountFor', { month: D.monthLabel(month, lang) })}</span>
              <span class="value pending">${t('st.pending')}</span>
              <span class="hint">${t('m.pendingHint')}</span>
            </a>`}
      </div>
      ${!isChild && isPlaceholderEmail(req.user.email)
        ? html`<a class="notice notice-link" href="/mitglied/moji-podaci">✉️ ${t('m.emailHint')} ${t('m.enterEmail')}</a>`
        : ''}
      ${req.unreadNews && !isChild
        ? html`<a class="notice notice-link" href="/mitglied/aktuelnosti">📬 ${t('m.unreadBefore')} <strong>${req.unreadNews}</strong> ${t('m.unreadAfter')}</a>`
        : ''}
      ${weekReleased ? '' : html`<p class="notice">${t('week.notPublished')}</p>`}
      ${weekView({ monday, lessons, baseUrl: '/mitglied', today, lang, holidays: weekReleased ? holidaysBetween(db, monday, D.addDays(monday, 6)) : new Map() })}
      <section class="card">
        <h2>${t('m.upcoming')}</h2>
        ${upcoming.length === 0
          ? html`<p class="muted">${t('m.noUpcoming')}</p>`
          : html`<ul class="list">${upcoming.map(
              (l) => html`<li><strong>${D.formatDateLong(l.date, lang)}</strong> · ${lessonTimeRange(l)} h
                ${l.court ? html`· ${t('lesson.court', { court: l.court })}` : ''} · ${lessonKindLabel(l, lang)} — ${req.user.name}</li>`
            )}</ul>`}
      </section>
      ${emailPrompt ? emailPromptDialog(req, emailPrompt) : ''}`,
    })));
  });

  // ---------------------------------------------------------------- Prozor „unesite e-mail“ nakon prijave
  // Pojavljuje se samo u prijavi u kojoj je označen (vidi /login) i samo dok član nema e-mail.
  // Postojeća napomena na stranici ostaje nepromijenjena.
  const hasNoEmail = (user) => !user.email || isPlaceholderEmail(user.email);
  const showEmailPrompt = (req) => !!req.session.emailPrompt && !req.user.parent_id && hasNoEmail(req.user);

  // Podaci za prozor (greška i upisana adresa iz prethodnog pokušaja se prikazuju samo jednom).
  function takeEmailPrompt(req, res) {
    if (!showEmailPrompt(req)) return null;
    const prompt = { error: req.session.emailPromptError || null, value: req.session.emailPromptValue || '' };
    if (prompt.error || prompt.value) {
      delete req.session.emailPromptError;
      delete req.session.emailPromptValue;
      res.saveSession();
    }
    return prompt;
  }

  function emailPromptDialog(req, { error, value }) {
    const { t } = req;
    return html`
      <div class="modal-backdrop" id="email-prozor">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="email-prozor-title">
          <h2 id="email-prozor-title">${t('m.popupTitle')}</h2>
          <p>${t('m.popupText')}</p>
          ${error ? html`<p class="modal-error" role="alert">${error}</p>` : ''}
          <form method="post" action="/mitglied/email-prozor" class="stack">
            ${csrfField(req)}
            <label>${t('field.email')}
              <input name="email" type="email" required maxlength="200" autocomplete="email" autofocus value="${value}">
            </label>
            <button class="btn btn-primary" type="submit">${t('btn.saveShort')}</button>
          </form>
          <form method="post" action="/mitglied/email-prozor/kasnije" class="modal-later">
            ${csrfField(req)}
            <button class="btn btn-ghost" type="submit">${t('m.later')}</button>
          </form>
        </section>
      </div>`;
  }

  router.post('/email-prozor', (req, res) => {
    if (!showEmailPrompt(req)) return res.redirect('/mitglied');
    const email = text(req.body.email, 200);
    let error = null;
    if (!EMAIL_RE.test(email) || isPlaceholderEmail(email)) error = req.t('email.invalid');
    else if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, req.user.id)) {
      error = req.t('email.taken');
    }
    if (error) {
      req.session.emailPromptError = error;
      req.session.emailPromptValue = email;
      res.saveSession();
      return res.redirect('/mitglied');
    }
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    logActivity(db, req, 'Članovi', `${req.user.name} – e-mail unesen (prozor nakon prijave): ${email}`);
    delete req.session.emailPrompt;
    res.flash('success', req.t('email.savedThanks'));
    res.redirect('/mitglied');
  });

  router.post('/email-prozor/kasnije', (req, res) => {
    delete req.session.emailPrompt;
    delete req.session.emailPromptError;
    delete req.session.emailPromptValue;
    res.saveSession();
    res.redirect('/mitglied');
  });

  // Mjesečni iznos (samo informativno, bez funkcije plaćanja).
  // Članovi vide samo tekući mjesec i tri mjeseca unazad.
  router.get('/abrechnung', (req, res) => {
    const { min, max } = memberMonthRange();
    let month = D.isValidMonth(req.query.monat) ? req.query.monat : max;
    if (month < min) month = min;
    if (month > max) month = max;
    const full = monthlyStatement(db, req.user, month);
    // Termini iz još neobjavljenih sedmica se ne navode pojedinačno (iznos ostaje u ukupnom zbiru).
    const shown = visibleOnly(full.lessons);
    const statement = { ...full, lessons: shown, unpublishedCount: full.lessons.length - shown.length };
    // „Ko je pogledao“: računa se samo odobren obračun (iznos je zaista vidljiv).
    if (statement.released) recordView(db, { kind: 'iznosi', period: month, viewerType: 'clan', viewerId: req.user.id, playerIds: [req.user.id] });
    const history = [];
    for (let m = max; m >= min; m = D.addMonths(m, -1)) history.push(monthlyStatement(db, req.user, m));
    const { t, lang } = req;
    res.send(String(layout(req, {
      title: t('nav.monthly'),
      body: html`
      <div class="page-head">
        <div>
          <h1>${t('nav.monthly')}</h1>
          <p class="muted">${t('m.monthlyIntro', { month: D.monthLabel(month, lang) })}</p>
        </div>
      </div>
      ${monthNav('/mitglied/abrechnung', month, '', { min, max, lang })}
      ${statement.released
        ? html`<div class="summary-tile big">
            <span class="label">${statement.paid || statement.noTraining ? t('m.amountForMonth') : t('m.payAtEnd')} · ${paymentBadge(statement, { lang })}</span>
            <span class="value">${formatMoney(statement.total)}</span>
            ${statement.manual ? '' : html`<span class="hint">${t('st.termsHours', { n: statement.lessonCount, hours: formatHours(statement.hours, lang) })}${
              req.user.hourly_rate_cents ? ` · ${t('m.perHour', { amount: formatMoney(req.user.hourly_rate_cents) })}` : ''}</span>`}
          </div>
          ${statementTable(statement, { lang })}`
        : html`<div class="summary-tile big pending-tile">
            <span class="label">${D.monthLabel(month, lang)}</span>
            <span class="value pending">${t('st.pending')}</span>
            <span class="hint">${t('m.pendingLong')}</span>
          </div>`}
      <section class="card">
        <h2>${t('m.history')}</h2>
        <p class="muted small">${t('m.historyNote', { n: MEMBER_MONTHS_BACK })}</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>${t('field.month')}</th><th class="num">${t('field.amount')}</th><th>${t('field.status')}</th></tr></thead>
            <tbody>${history.map((h) => html`
              <tr${h.month === month ? html` class="is-selected"` : ''}>
                <td><a href="/mitglied/abrechnung?monat=${h.month}">${D.monthLabel(h.month, lang)}</a></td>
                <td class="num">${h.released ? formatMoney(h.total) : '–'}</td>
                <td>${h.released ? paymentBadge(h, { lang }) : html`<span class="tag tag-pending">${t('st.pending')}</span>`}</td>
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
    const { t, lang } = req;
    res.send(String(layout(req, {
      title: t('nav.news'),
      body: html`
      <div class="page-head"><div>
        <h1>${t('nav.news')}</h1>
        <p class="muted">${t('news.intro')}</p>
      </div></div>
      ${items.length === 0
        ? html`<p class="card muted">${t('news.empty')}</p>`
        : html`<ul class="inbox">${items.map((n) => html`
            <li class="${n.read_at ? '' : 'is-unread'}">
              <a href="/mitglied/aktuelnosti/${n.id}">
                <span class="inbox-title">${n.read_at ? '' : html`<span class="dot" aria-label="${t('nav.unread')}"></span>`}${n.title}</span>
                <span class="inbox-date">${D.formatDate(n.created_at.slice(0, 10), lang)}</span>
                <span class="inbox-preview">${n.body.length > 140 ? `${n.body.slice(0, 140)}…` : n.body}</span>
              </a>
            </li>`)}</ul>`}`,
    })));
  });

  router.get('/aktuelnosti/:id', (req, res) => {
    const id = Number(req.params.id);
    const item = Number.isInteger(id) ? oneNews.get(req.user.id, id) : null;
    if (!item) return res.status(404).send(req.t('err.newsNotFound'));
    if (!item.read_at) {
      db.prepare("UPDATE news_recipients SET read_at = datetime('now') WHERE news_id = ? AND user_id = ?").run(item.id, req.user.id);
      req.unreadNews = Math.max(0, req.unreadNews - 1);
    }
    res.send(String(layout(req, {
      title: item.title,
      body: html`
      <a class="btn btn-ghost btn-sm" href="/mitglied/aktuelnosti">${req.t('news.back')}</a>
      <article class="card news-article">
        <p class="muted small">${D.formatDateLong(item.created_at.slice(0, 10), req.lang)}</p>
        <h1>${item.title}</h1>
        <div class="pre">${item.body}</div>
      </article>`,
    })));
  });

  // ---------------------------------------------------------------- Djeca (dječiji računi)
  // Roditelj (običan član) kreira i upravlja samo svojim dječijim računima. Svi upiti su vezani
  // za parent_id prijavljenog člana – tuđi računi se ne mogu ni vidjeti ni mijenjati.
  function requireParent(req, res, next) {
    if (req.user.role !== 'member' || req.user.parent_id) {
      res.status(403);
      return res.send(req.t('err.noAccess'));
    }
    next();
  }
  const myChildren = db.prepare("SELECT * FROM users WHERE parent_id = ? AND role = 'member' ORDER BY name COLLATE NOCASE, id");
  const myChild = db.prepare("SELECT * FROM users WHERE id = ? AND parent_id = ? AND role = 'member'");
  const childOf = (req) => {
    const id = Number(req.params.id);
    return Number.isInteger(id) ? myChild.get(id, req.user.id) : null;
  };

  function childrenPage(req, { values = {}, errors = [] } = {}) {
    const children = myChildren.all(req.user.id);
    const { t } = req;
    return layout(req, {
      title: t('nav.children'),
      body: html`
      <div class="page-head"><div>
        <h1>${t('kids.h1')}</h1>
        <p class="muted">${t('kids.intro')}</p>
      </div></div>
      <section class="card">
        <h2>${t('kids.mine')}</h2>
        ${children.length === 0
          ? html`<p class="muted">${t('kids.none')}</p>`
          : html`<div class="table-wrap"><table>
            <thead><tr><th>${t('field.name')}</th><th>${t('field.username')}</th><th>${t('kids.newPassword')}</th><th></th></tr></thead>
            <tbody>${children.map((c) => html`<tr>
              <td><strong>${c.name}</strong></td>
              <td><code>${c.username}</code></td>
              <td>
                <form method="post" action="/mitglied/djeca/${c.id}/lozinka" class="inline-form">
                  ${csrfField(req)}
                  <input name="password" type="text" minlength="8" required autocomplete="new-password" placeholder="${t('kids.min8Ph')}" aria-label="${t('kids.pwAria', { name: c.name })}">
                  <button class="btn btn-ghost btn-sm" type="submit">${t('kids.set')}</button>
                </form>
              </td>
              <td class="actions">
                <form method="post" action="/mitglied/djeca/${c.id}/obrisi" class="inline-form" data-confirm="${t('kids.confirmDelete', { name: c.name })}">
                  ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">${t('btn.delete')}</button>
                </form>
              </td>
            </tr>`)}</tbody></table></div>`}
      </section>
      <section class="card">
        <h2>${t('kids.new')}</h2>
        ${errorList(errors)}
        ${children.length >= CHILDREN_LIMIT ? html`<p class="notice">${t('kids.limit')}</p>` : html`
        <form method="post" action="/mitglied/djeca" class="form-grid">
          ${csrfField(req)}
          <label>${t('kids.childName')}<input name="name" required maxlength="120" value="${values.name || ''}"></label>
          <label>${t('kids.username')}<input name="username" required minlength="3" maxlength="40" autocapitalize="none" spellcheck="false" value="${values.username || ''}">
            <span class="small muted">${t('kids.usernameHint')}</span></label>
          <label>${t('kids.password')}<input name="password" type="text" required minlength="8" autocomplete="new-password"></label>
          <div class="span-2"><button class="btn btn-primary" type="submit">${t('kids.create')}</button></div>
        </form>`}
      </section>`,
    });
  }

  router.get('/djeca', requireParent, (req, res) => {
    res.send(String(childrenPage(req)));
  });

  router.post('/djeca', requireParent, (req, res) => {
    const values = { name: text(req.body.name, 120), username: normalizeUsername(text(req.body.username, 200)) };
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const errors = [];
    if (myChildren.all(req.user.id).length >= CHILDREN_LIMIT) {
      res.status(400);
      return res.send(String(childrenPage(req, { values })));
    }
    if (!values.name) errors.push(req.t('kids.noName'));
    if (!USERNAME_RE.test(values.username)) errors.push(req.t('kids.badUsername'));
    else if (usernameTaken(db, values.username)) errors.push(req.t('kids.taken'));
    if (password.length < 8) errors.push(req.t('pw.min8'));
    if (errors.length) {
      res.status(400);
      return res.send(String(childrenPage(req, { values, errors })));
    }
    db.prepare(
      `INSERT INTO users (name, username, email, password_hash, role, hourly_rate_cents, monthly_fee_cents, active, parent_id)
       VALUES (?, ?, ?, ?, 'member', 0, 0, 1, ?)`
    ).run(values.name, values.username, placeholderEmail(values.username), hashPassword(password), req.user.id);
    logActivity(db, req, 'Članovi', `${req.user.name} – dječiji račun napravljen: ${values.name} (${values.username})`);
    res.flash('success', req.t('kids.created', { name: values.name, username: values.username }));
    res.redirect('/mitglied/djeca');
  });

  router.post('/djeca/:id/lozinka', requireParent, (req, res) => {
    const child = childOf(req);
    if (!child) return res.status(404).send(req.t('err.notFoundShort'));
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (password.length < 8) {
      res.flash('error', req.t('pw.min8'));
    } else {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND parent_id = ?').run(hashPassword(password), child.id, req.user.id);
      logActivity(db, req, 'Članovi', `${req.user.name} – dječiji račun ${child.name}: lozinka promijenjena`);
      endSessionsFor(db, 'user', child.id);
      res.flash('success', req.t('kids.pwSet', { name: child.name }));
    }
    res.redirect('/mitglied/djeca');
  });

  router.post('/djeca/:id/obrisi', requireParent, (req, res) => {
    const child = childOf(req);
    if (!child) return res.status(404).send(req.t('err.notFoundShort'));
    db.prepare('DELETE FROM users WHERE id = ? AND parent_id = ?').run(child.id, req.user.id);
    logActivity(db, req, 'Članovi', `${req.user.name} – dječiji račun obrisan: ${child.name}`);
    res.flash('success', req.t('kids.deleted', { name: child.name }));
    res.redirect('/mitglied/djeca');
  });

  // ---------------------------------------------------------------- Vlastita e-mail adresa
  // ---------------------------------------------------------------- Moji podaci (e-mail i telefon)
  // Ime i korisničko ime se samo prikazuju. Lozinka se traži samo kad se mijenja već upisana e-mail adresa.
  const PHONE_RE = /^[0-9+()\/.\s-]{0,50}$/;
  const realEmail = (user) => (user.email && !isPlaceholderEmail(user.email) ? user.email : '');

  function myDataPage(req, { values, errors = [], askPassword = false } = {}) {
    const saved = realEmail(req.user);
    const v = values || { email: saved, phone: req.user.phone || '' };
    const { t } = req;
    return layout(req, {
      title: t('nav.myData'),
      body: html`
      <section class="card narrow">
        <h1>${t('nav.myData')}</h1>
        ${saved ? '' : html`<p class="notice">${t('m.emailHint')}</p>`}
        <dl class="my-data">
          <div><dt>${t('field.fullName')}</dt><dd>${req.user.name}</dd></div>
          <div><dt>${t('field.username')}</dt><dd>${req.user.username || '–'}</dd></div>
        </dl>
        <p class="muted small">${t('data.onlySchool')}</p>
        ${errorList(errors)}
        <form method="post" action="/mitglied/moji-podaci" class="stack">
          ${csrfField(req)}
          <label>${t('field.email')}
            <input name="email" type="email" maxlength="200" autocomplete="email" value="${v.email}"${saved ? ' required' : ''}>
            <span class="hint">${t('data.emailHint')}</span>
          </label>
          <label>${t('field.phone')}
            <input name="phone" type="tel" maxlength="50" autocomplete="tel" value="${v.phone}">
          </label>
          ${askPassword ? html`<div class="confirm-box">
            <p><strong>${t('data.changing')}</strong> ${t('data.confirmPw')}</p>
            <label>${t('data.yourPw')}
              <input name="password" type="password" required autocomplete="current-password" autofocus>
              <span class="hint">${t('data.pwHint')}</span>
            </label>
          </div>` : ''}
          <button class="btn btn-primary" type="submit">${t('btn.saveShort')}</button>
          ${askPassword ? html`<a class="btn btn-ghost" href="/mitglied/moji-podaci">${t('btn.cancel')}</a>` : ''}
        </form>
      </section>`,
    });
  }

  router.get('/moji-podaci', (req, res) => {
    if (req.user.role !== 'member') return res.redirect('/');
    res.send(String(myDataPage(req)));
  });

  router.post('/moji-podaci', (req, res) => {
    if (req.user.role !== 'member') return res.status(403).send(req.t('err.noAccess'));
    const values = { email: text(req.body.email, 200), phone: text(req.body.phone, 50) };
    const saved = realEmail(req.user);
    const errors = [];
    if (values.email === '') {
      if (saved) errors.push(req.t('data.emailEmpty'));
    } else if (!EMAIL_RE.test(values.email) || isPlaceholderEmail(values.email)) {
      errors.push(req.t('data.emailInvalid'));
    } else if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(values.email, req.user.id)) {
      errors.push(req.t('email.taken'));
    }
    if (!PHONE_RE.test(values.phone)) errors.push(req.t('data.badPhone'));
    // Promjena već upisane adrese (ne samo velika/mala slova) traži lozinku za BetterTennis.
    const emailChanged = !!saved && values.email.toLowerCase() !== saved.toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (errors.length) {
      res.status(400);
      return res.send(String(myDataPage(req, { values, errors, askPassword: emailChanged && !!values.email })));
    }
    if (emailChanged) {
      if (!password) return res.send(String(myDataPage(req, { values, askPassword: true })));
      if (!verifyPassword(password, req.user.password_hash)) {
        res.status(400);
        return res.send(String(myDataPage(req, { values, askPassword: true, errors: [req.t('data.wrongPw')] })));
      }
    }
    // Bez e-maila ostaje interna zamjenska adresa (kao do sada).
    db.prepare('UPDATE users SET email = ?, phone = ? WHERE id = ?')
      .run(values.email || req.user.email, values.phone || null, req.user.id);
    const diff = changes([['E-mail', saved, values.email || saved], ['Telefon', req.user.phone, values.phone]]);
    if (diff) logActivity(db, req, 'Članovi', `${req.user.name} – moji podaci: ${diff}`);
    res.flash('success', req.t('data.saved'));
    res.redirect('/mitglied/moji-podaci');
  });

  // Ranija stranica „E-mail“ je sada dio „Moji podaci“.
  router.get('/email', (req, res) => res.redirect('/mitglied/moji-podaci'));
  router.post('/email', (req, res) => res.redirect('/mitglied/moji-podaci'));

  function passwordPage(req, errors = []) {
    const { t } = req;
    return layout(req, {
      title: t('pw.title'),
      body: html`
      <section class="card narrow">
        <h1>${t('pw.title')}</h1>
        ${errorList(errors)}
        <form method="post" action="/mitglied/passwort" class="stack">
          ${csrfField(req)}
          <label>${t('pw.current')}
            <input name="current" type="password" required autocomplete="current-password">
          </label>
          <label>${t('pw.new')}
            <input name="password" type="password" required minlength="8" autocomplete="new-password">
          </label>
          <label>${t('pw.repeat')}
            <input name="password2" type="password" required minlength="8" autocomplete="new-password">
          </label>
          <button class="btn btn-primary" type="submit">${t('btn.save')}</button>
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
    if (!verifyPassword(current, req.user.password_hash)) errors.push(req.t('pw.currentWrong'));
    if (typeof password !== 'string' || password.length < 8) errors.push(req.t('pw.newMin8'));
    if (password !== password2) errors.push(req.t('pw.newMismatch'));
    if (errors.length) {
      res.status(400);
      return res.send(String(passwordPage(req, errors)));
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.id);
    logActivity(db, req, 'Članovi', `${req.user.name} – lozinka promijenjena`);
    endSessionsFor(db, 'user', req.user.id, { keep: req.session.sid }); // ostali uređaji se odjavljuju
    res.flash('success', req.t('pw.changed'));
    res.redirect(req.user.role === 'admin' ? '/admin' : '/mitglied');
  });

  // ---------------------------------------------------------------- Privatni časovi (upit)
  // Član vidi slobodne, neblokirane termine koji još nisu počeli (sarajevsko vrijeme) i šalje upit.
  // Upit ne blokira termin – drugi članovi ga i dalje mogu tražiti; isti član ga ne može tražiti dvaput.
  const getPrivateSlot = db.prepare('SELECT * FROM private_slots WHERE id = ?');
  const myPrivateRequest = db.prepare('SELECT id FROM private_requests WHERE slot_id = ? AND user_id = ?');
  const slotIdParam = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  router.get('/privatni-cas', (req, res) => {
    const now = Date.now();
    const slots = db.prepare('SELECT * FROM private_slots WHERE blocked = 0 ORDER BY date, start_time, id').all()
      .filter((s) => isSlotOpen(s, now))
      .sort((a, b) => slotStartMs(a) - slotStartMs(b) || a.id - b.id);
    const requested = new Set(db.prepare('SELECT slot_id FROM private_requests WHERE user_id = ? AND slot_id IS NOT NULL')
      .all(req.user.id).map((r) => r.slot_id));
    const { t, lang } = req;
    res.send(String(layout(req, {
      title: t('nav.privateLesson'),
      body: html`
      <div class="page-head"><div>
        <h1>${t('nav.privateLesson')}</h1>
        <p class="muted">${t('pl.intro')}</p>
      </div></div>
      <section class="card">
        ${slots.length === 0
          ? html`<p class="empty">${t('pl.none')}</p>`
          : html`<ul class="private-slots">${slots.map((s) => html`<li class="private-slot" data-slot="${s.id}">${requested.has(s.id)
            ? html`<span class="private-slot-label">${slotLabel(s, lang)}</span> <span class="tag tag-done">${t('pl.sent')}</span>`
            : html`<a class="private-slot-link" href="/mitglied/privatni-cas/${s.id}"><span class="private-slot-label">${slotLabel(s, lang)}</span> <span class="private-slot-cta">${t('pl.send')}</span></a>`}</li>`)}</ul>`}
      </section>`,
    })));
  });

  router.get('/privatni-cas/:id', (req, res) => {
    const slot = getPrivateSlot.get(slotIdParam(req.params.id));
    if (!isSlotOpen(slot)) {
      res.flash('error', req.t('pl.gone'));
      return res.redirect('/mitglied/privatni-cas');
    }
    if (myPrivateRequest.get(slot.id, req.user.id)) {
      res.flash('success', req.t('pl.already'));
      return res.redirect('/mitglied/privatni-cas');
    }
    res.send(String(layout(req, {
      title: req.t('nav.privateLesson'),
      body: html`
      <section class="card confirm-card">
        <h1>${req.t('pl.confirmQ')}</h1>
        <p class="lead"><strong>${slotLabel(slot, req.lang)}</strong></p>
        <form method="post" action="/mitglied/privatni-cas/${slot.id}" class="btn-row">
          ${csrfField(req)}
          <button class="btn btn-primary" type="submit">${req.t('pl.yes')}</button>
          <a class="btn btn-ghost" href="/mitglied/privatni-cas">${req.t('pl.no')}</a>
        </form>
      </section>`,
    })));
  });

  router.post('/privatni-cas/:id', async (req, res) => {
    const slot = getPrivateSlot.get(slotIdParam(req.params.id));
    if (!isSlotOpen(slot)) {
      res.flash('error', req.t('pl.goneThis'));
      return res.redirect('/mitglied/privatni-cas');
    }
    if (myPrivateRequest.get(slot.id, req.user.id)) {
      res.flash('success', req.t('pl.already'));
      return res.redirect('/mitglied/privatni-cas');
    }
    const requestedAt = new Date().toISOString();
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO private_requests (slot_id, user_id, slot_date, slot_start, slot_end, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(slot.id, req.user.id, slot.date, slot.start_time, slot.end_time, requestedAt);
    if (inserted.changes) logActivity(db, req, 'Privatni časovi', `upit poslan – ${req.user.name}, ${slotLabel(slot)}`);
    if (inserted.changes && mailer && notifyEmail) {
      const u = req.user;
      const contact = [u.phone && `Telefon: ${u.phone}`, u.email && !isPlaceholderEmail(u.email) && `E-mail: ${u.email}`]
        .filter(Boolean).join('\n');
      let ok = false;
      let reason = 'slanje nije uspjelo (detalji iznad u logu)';
      try {
        ok = await mailer.send({
          to: notifyEmail,
          subject: `Novi upit za privatni čas – ${u.name}`,
          text: `Novi upit za privatni čas\n\nČlan: ${u.name}${u.username ? ` (${u.username})` : ''}\n${contact ? `${contact}\n` : ''}`
            + `Termin: ${slotLabel(slot)}\nUpit poslan: ${formatSarajevo(requestedAt)}\n\n`
            + 'Svi upiti: Admin → Privatni časovi',
        });
      } catch (err) {
        reason = err.message;
      }
      if (!ok) console.error(`Obavijest o upitu za privatni čas nije poslana na ${notifyEmail}: ${reason}`);
    }
    res.flash('success', req.t('pl.thanks'));
    res.redirect('/mitglied/privatni-cas');
  });

  return router;
};
