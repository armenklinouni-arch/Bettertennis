'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { monthlyStatement, formatHours, memberMonthRange, MEMBER_MONTHS_BACK } = require('../billing');
const {
  layout, csrfField, errorList, weekView, statementTable, monthNav, paymentBadge, lessonTimeRange, lessonKindLabel,
} = require('../views');
const { requireMember, hashPassword, verifyPassword } = require('../auth');
const { isWeekReleased } = require('../weeks');
const { USERNAME_RE, normalizeUsername, usernameTaken, placeholderEmail, CHILDREN_LIMIT } = require('../db');

function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

module.exports = function memberRoutes(db) {
  const router = express.Router();
  router.use(requireMember);

  // Dječiji račun (kreirao ga je roditelj) smije vidjeti samo svoj sedmični raspored –
  // nikakve iznose, plaćanja, obračune, aktuelnosti ni postavke.
  router.use((req, res, next) => {
    if (req.user.parent_id && !(req.method === 'GET' && req.path === '/')) {
      res.status(403);
      return res.send('Nemate pristup: dječiji račun vidi samo svoj sedmični raspored.');
    }
    next();
  });

  const weekLessons = db.prepare(
    // Namjerno bez imena trenera: članovi ne smiju vidjeti koji trener radi s njima.
    `SELECT l.*, u.name AS member_name FROM lessons l
       JOIN users u ON u.id = l.user_id
      WHERE l.user_id = ? AND l.date BETWEEN ? AND ?
      ORDER BY l.date, l.start_time`
  );
  const upcomingLessons = db.prepare(
    `SELECT * FROM lessons WHERE user_id = ? AND date >= ? AND cancelled = 0
      ORDER BY date, start_time LIMIT 200`
  );
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
    const lessons = weekReleased ? weekLessons.all(req.user.id, monday, D.addDays(monday, 6)) : [];
    const month = D.monthOf(today);
    const isChild = !!req.user.parent_id;
    const statement = isChild ? null : monthlyStatement(db, req.user, month);
    const upcoming = visibleOnly(upcomingLessons.all(req.user.id, today)).slice(0, 5);
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
        ${isChild ? '' : statement.released
          ? html`<a class="summary-tile" href="/mitglied/abrechnung?monat=${month}">
              <span class="label">Iznos za ${D.monthLabel(month)}</span>
              <span class="value">${formatMoney(statement.total)}</span>
              <span class="hint">${statement.manual ? 'Ručni obračun' : `Termini: ${statement.lessonCount}`} · ${paymentBadge(statement)}</span>
            </a>`
          : html`<a class="summary-tile" href="/mitglied/abrechnung?monat=${month}">
              <span class="label">Iznos za ${D.monthLabel(month)}</span>
              <span class="value pending">Obračun u pripremi</span>
              <span class="hint">Iznos će biti vidljiv kad ga škola odobri.</span>
            </a>`}
      </div>
      ${req.unreadNews && !isChild
        ? html`<a class="notice notice-link" href="/mitglied/aktuelnosti">📬 Imaš nepročitane aktuelnosti: <strong>${req.unreadNews}</strong> – otvori sandučić →</a>`
        : ''}
      ${weekReleased ? '' : html`<p class="notice">Raspored za ovu sedmicu još nije objavljen. Bit će vidljiv čim ga teniska škola objavi.</p>`}
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
    const full = monthlyStatement(db, req.user, month);
    // Termini iz još neobjavljenih sedmica se ne navode pojedinačno (iznos ostaje u ukupnom zbiru).
    const shown = visibleOnly(full.lessons);
    const statement = { ...full, lessons: shown, unpublishedCount: full.lessons.length - shown.length };
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
      ${statement.released
        ? html`<div class="summary-tile big">
            <span class="label">${statement.paid ? 'Iznos za mjesec' : 'Za platiti na kraju mjeseca'} · ${paymentBadge(statement)}</span>
            <span class="value">${formatMoney(statement.total)}</span>
            <span class="hint">${statement.manual ? 'Ručni obračun' : `Termini: ${statement.lessonCount} · ${formatHours(statement.hours)}`}${
              req.user.hourly_rate_cents ? ` · ${formatMoney(req.user.hourly_rate_cents)} po satu` : ''}</span>
          </div>
          ${statementTable(statement)}`
        : html`<div class="summary-tile big pending-tile">
            <span class="label">${D.monthLabel(month)}</span>
            <span class="value pending">Obračun u pripremi</span>
            <span class="hint">Obračun za ovaj mjesec još se priprema. Iznos i stavke bit će vidljivi kad ih škola odobri.</span>
          </div>`}
      <section class="card">
        <h2>Pregled plaćanja</h2>
        <p class="muted small">Prikazan je tekući mjesec i ${MEMBER_MONTHS_BACK} mjeseca unazad.</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Mjesec</th><th class="num">Iznos</th><th>Status</th></tr></thead>
            <tbody>${history.map((h) => html`
              <tr${h.month === month ? html` class="is-selected"` : ''}>
                <td><a href="/mitglied/abrechnung?monat=${h.month}">${D.monthLabel(h.month)}</a></td>
                <td class="num">${h.released ? formatMoney(h.total) : '–'}</td>
                <td>${h.released ? paymentBadge(h) : html`<span class="tag tag-pending">Obračun u pripremi</span>`}</td>
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

  // ---------------------------------------------------------------- Djeca (dječiji računi)
  // Roditelj (običan član) kreira i upravlja samo svojim dječijim računima. Svi upiti su vezani
  // za parent_id prijavljenog člana – tuđi računi se ne mogu ni vidjeti ni mijenjati.
  function requireParent(req, res, next) {
    if (req.user.role !== 'member' || req.user.parent_id) {
      res.status(403);
      return res.send('Nemate pristup.');
    }
    next();
  }
  const myChildren = db.prepare("SELECT * FROM users WHERE parent_id = ? AND role = 'member' ORDER BY name COLLATE NOCASE, id");
  const myChild = db.prepare("SELECT * FROM users WHERE id = ? AND parent_id = ? AND role = 'member'");
  const childOf = (req) => {
    const id = Number(req.params.id);
    return Number.isInteger(id) ? myChild.get(id, req.user.id) : null;
  };

  const LIMIT_NOTICE = 'Možeš imati najviše jedan dječiji račun, a već ga imaš. Postojeći račun možeš i dalje uređivati – '
    + 'postaviti novu lozinku ili ga obrisati i napraviti novi.';

  function childrenPage(req, { values = {}, errors = [] } = {}) {
    const children = myChildren.all(req.user.id);
    return layout(req, {
      title: 'Djeca',
      body: html`
      <div class="page-head"><div>
        <h1>Dječiji računi</h1>
        <p class="muted">Za svako dijete možeš napraviti vlastiti pristup. Dijete nakon prijave vidi samo
          svoj sedmični raspored treninga – bez iznosa, plaćanja i obračuna.</p>
      </div></div>
      <section class="card">
        <h2>Moja djeca</h2>
        ${children.length === 0
          ? html`<p class="muted">Još nisi napravio/la nijedan dječiji račun.</p>`
          : html`<div class="table-wrap"><table>
            <thead><tr><th>Ime</th><th>Korisničko ime</th><th>Nova lozinka</th><th></th></tr></thead>
            <tbody>${children.map((c) => html`<tr>
              <td><strong>${c.name}</strong></td>
              <td><code>${c.username}</code></td>
              <td>
                <form method="post" action="/mitglied/djeca/${c.id}/lozinka" class="inline-form">
                  ${csrfField(req)}
                  <input name="password" type="text" minlength="8" required autocomplete="new-password" placeholder="najmanje 8 znakova" aria-label="Nova lozinka za ${c.name}">
                  <button class="btn btn-ghost btn-sm" type="submit">Postavi</button>
                </form>
              </td>
              <td class="actions">
                <form method="post" action="/mitglied/djeca/${c.id}/obrisi" class="inline-form" data-confirm="Trajno obrisati račun za ${c.name}?">
                  ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
                </form>
              </td>
            </tr>`)}</tbody></table></div>`}
      </section>
      <section class="card">
        <h2>Novi dječiji račun</h2>
        ${errorList(errors)}
        ${children.length >= CHILDREN_LIMIT ? html`<p class="notice">${LIMIT_NOTICE}</p>` : html`
        <form method="post" action="/mitglied/djeca" class="form-grid">
          ${csrfField(req)}
          <label>Ime i prezime djeteta *<input name="name" required maxlength="120" value="${values.name || ''}"></label>
          <label>Korisničko ime *<input name="username" required minlength="3" maxlength="40" autocapitalize="none" spellcheck="false" value="${values.username || ''}">
            <span class="small muted">3–40 znakova: slova bez kvačica, brojevi, tačka, crtica, donja crta.</span></label>
          <label>Lozinka * (najmanje 8 znakova)<input name="password" type="text" required minlength="8" autocomplete="new-password"></label>
          <div class="span-2"><button class="btn btn-primary" type="submit">Napravi račun</button></div>
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
    if (!values.name) errors.push('Unesi ime djeteta.');
    if (!USERNAME_RE.test(values.username)) errors.push('Neispravno korisničko ime (3–40 znakova: a–z, 0–9, tačka, crtica, donja crta).');
    else if (usernameTaken(db, values.username)) errors.push('Ovo korisničko ime je već zauzeto.');
    if (password.length < 8) errors.push('Lozinka mora imati najmanje 8 znakova.');
    if (errors.length) {
      res.status(400);
      return res.send(String(childrenPage(req, { values, errors })));
    }
    db.prepare(
      `INSERT INTO users (name, username, email, password_hash, role, hourly_rate_cents, monthly_fee_cents, active, parent_id)
       VALUES (?, ?, ?, ?, 'member', 0, 0, 1, ?)`
    ).run(values.name, values.username, placeholderEmail(values.username), hashPassword(password), req.user.id);
    res.flash('success', `Račun za ${values.name} je napravljen. Prijava: ${values.username}`);
    res.redirect('/mitglied/djeca');
  });

  router.post('/djeca/:id/lozinka', requireParent, (req, res) => {
    const child = childOf(req);
    if (!child) return res.status(404).send('Nije pronađeno.');
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (password.length < 8) {
      res.flash('error', 'Lozinka mora imati najmanje 8 znakova.');
    } else {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND parent_id = ?').run(hashPassword(password), child.id, req.user.id);
      res.flash('success', `Nova lozinka za ${child.name} je postavljena.`);
    }
    res.redirect('/mitglied/djeca');
  });

  router.post('/djeca/:id/obrisi', requireParent, (req, res) => {
    const child = childOf(req);
    if (!child) return res.status(404).send('Nije pronađeno.');
    db.prepare('DELETE FROM users WHERE id = ? AND parent_id = ?').run(child.id, req.user.id);
    res.flash('success', `Račun za ${child.name} je obrisan.`);
    res.redirect('/mitglied/djeca');
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
