'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatEUR, centsToInput, parseEUR, lessonPrice } = require('../money');
const { monthlyStatement, formatHours } = require('../billing');
const { layout, csrfField, errorList, weekView, statementTable, monthNav, lessonTimeRange } = require('../views');
const { requireAdmin, hashPassword } = require('../auth');
const { EMAIL_RE, str } = require('./public');

const LEAD_STATUSES = ['neu', 'kontaktiert', 'Probestunde', 'Mitglied', 'abgelehnt'];
const DURATIONS = [30, 45, 60, 90, 120];
const MAX_REPEAT_WEEKS = 52;

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = function adminRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const getMember = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'");
  const allMembers = db.prepare("SELECT * FROM users WHERE role = 'member' ORDER BY active DESC, name COLLATE NOCASE");
  const activeMembers = db.prepare("SELECT * FROM users WHERE role = 'member' AND active = 1 ORDER BY name COLLATE NOCASE");

  function notFound(res, what = 'Eintrag') {
    res.status(404);
    return res.send(`${what} nicht gefunden.`);
  }

  // ---------------------------------------------------------------- Übersicht
  router.get('/', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(today);
    const month = D.monthOf(today);
    const newLeads = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'neu'").get().n;
    const memberCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member' AND active = 1").get().n;
    const weekCount = db
      .prepare('SELECT COUNT(*) AS n FROM lessons WHERE cancelled = 0 AND date BETWEEN ? AND ?')
      .get(monday, D.addDays(monday, 6)).n;
    const monthTotal = activeMembers.all().reduce((sum, m) => sum + monthlyStatement(db, m, month).total, 0);
    const todays = db
      .prepare(
        `SELECT l.*, u.name AS member_name FROM lessons l JOIN users u ON u.id = l.user_id
          WHERE l.date = ? ORDER BY l.start_time`
      )
      .all(today);
    const latestLeads = db.prepare("SELECT * FROM leads WHERE status = 'neu' ORDER BY id DESC LIMIT 5").all();

    res.send(String(layout(req, {
      title: 'Admin',
      body: html`
      <h1>Verwaltung</h1>
      <div class="tiles">
        <a class="summary-tile" href="/admin/interessenten"><span class="label">Neue Interessenten</span><span class="value">${newLeads}</span></a>
        <a class="summary-tile" href="/admin/mitglieder"><span class="label">Aktive Mitglieder</span><span class="value">${memberCount}</span></a>
        <a class="summary-tile" href="/admin/termine"><span class="label">Termine diese Woche</span><span class="value">${weekCount}</span></a>
        <a class="summary-tile" href="/admin/abrechnung?monat=${month}"><span class="label">Summe ${D.monthLabel(month)}</span><span class="value">${formatEUR(monthTotal)}</span></a>
      </div>
      <div class="two-col">
        <section class="card">
          <h2>Heute, ${D.formatDateLong(today)}</h2>
          ${todays.length === 0
            ? html`<p class="muted">Heute stehen keine Trainings an.</p>`
            : html`<ul class="list">${todays.map((l) => html`
                <li class="${l.cancelled ? 'is-cancelled' : ''}"><strong>${lessonTimeRange(l)}</strong> · ${l.member_name}
                  ${l.court ? html`· Platz ${l.court}` : ''}${l.cancelled ? ' (abgesagt)' : ''}
                  <a href="/admin/termine/${l.id}">bearbeiten</a></li>`)}</ul>`}
        </section>
        <section class="card">
          <h2>Neue Anfragen</h2>
          ${latestLeads.length === 0
            ? html`<p class="muted">Keine neuen Anfragen.</p>`
            : html`<ul class="list">${latestLeads.map((l) => html`
                <li><strong>${l.name}</strong> · ${l.level || ''} · <a href="mailto:${l.email}">${l.email}</a></li>`)}</ul>
              <a href="/admin/interessenten">Alle Interessenten ansehen →</a>`}
        </section>
      </div>`,
    })));
  });

  // ---------------------------------------------------------------- Interessenten
  router.get('/interessenten', (req, res) => {
    const filter = LEAD_STATUSES.includes(req.query.status) ? req.query.status : '';
    const leads = filter
      ? db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY id DESC').all(filter)
      : db.prepare('SELECT * FROM leads ORDER BY id DESC').all();

    res.send(String(layout(req, {
      title: 'Interessenten',
      wide: true,
      body: html`
      <div class="page-head"><h1>Interessenten</h1></div>
      <nav class="filters" aria-label="Filter">
        <a href="/admin/interessenten" class="${filter ? '' : 'active'}">Alle</a>
        ${LEAD_STATUSES.map((s) => html`<a href="/admin/interessenten?status=${encodeURIComponent(s)}" class="${filter === s ? 'active' : ''}">${s}</a>`)}
      </nav>
      ${leads.length === 0
        ? html`<p class="card muted">Keine Einträge.</p>`
        : html`<div class="table-wrap"><table>
          <thead><tr><th>Eingang</th><th>Name / Kontakt</th><th>Spielstärke</th><th>Zeiten / Nachricht</th><th>Status</th><th></th></tr></thead>
          <tbody>${leads.map((l) => html`
            <tr>
              <td>${D.formatDate(l.created_at.slice(0, 10))}</td>
              <td><strong>${l.name}</strong><br><a href="mailto:${l.email}">${l.email}</a>${l.phone ? html`<br>${l.phone}` : ''}</td>
              <td>${l.level}</td>
              <td>${l.availability ? html`<div><em>${l.availability}</em></div>` : ''}${l.message ? html`<div class="pre">${l.message}</div>` : ''}</td>
              <td>
                <form method="post" action="/admin/interessenten/${l.id}/status" class="inline">
                  ${csrfField(req)}
                  <select name="status" aria-label="Status">${LEAD_STATUSES.map((s) => html`<option${l.status === s ? ' selected' : ''}>${s}</option>`)}</select>
                  <button class="btn btn-ghost btn-sm" type="submit">OK</button>
                </form>
              </td>
              <td class="actions">
                ${l.converted_user_id
                  ? html`<a class="btn btn-ghost btn-sm" href="/admin/mitglieder/${l.converted_user_id}">Zum Mitglied</a>`
                  : html`<a class="btn btn-primary btn-sm" href="/admin/mitglieder/neu?interessent=${l.id}">Als Mitglied anlegen</a>`}
                <form method="post" action="/admin/interessenten/${l.id}/loeschen" data-confirm="Anfrage von ${l.name} löschen?">
                  ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Löschen</button>
                </form>
              </td>
            </tr>`)}</tbody></table></div>`}`,
    })));
  });

  router.post('/interessenten/:id/status', (req, res) => {
    const status = req.body.status;
    if (!LEAD_STATUSES.includes(status)) return res.status(400).send('Ungültiger Status.');
    const r = db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, toId(req.params.id));
    if (!r.changes) return notFound(res, 'Interessent');
    res.flash('success', 'Status aktualisiert.');
    res.redirect('/admin/interessenten');
  });

  router.post('/interessenten/:id/loeschen', (req, res) => {
    db.prepare('DELETE FROM leads WHERE id = ?').run(toId(req.params.id));
    res.flash('success', 'Anfrage gelöscht.');
    res.redirect('/admin/interessenten');
  });

  // ---------------------------------------------------------------- Mitglieder
  router.get('/mitglieder', (req, res) => {
    const month = D.monthOf(D.todayISO());
    const members = allMembers.all();
    res.send(String(layout(req, {
      title: 'Mitglieder',
      wide: true,
      body: html`
      <div class="page-head">
        <h1>Mitglieder</h1>
        <a class="btn btn-primary" href="/admin/mitglieder/neu">+ Neues Mitglied</a>
      </div>
      ${members.length === 0
        ? html`<p class="card muted">Noch keine Mitglieder angelegt.</p>`
        : html`<div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Kontakt</th><th class="num">Preis / Std.</th><th class="num">Grundgebühr</th><th class="num">${D.monthLabel(month)}</th><th>Status</th><th></th></tr></thead>
          <tbody>${members.map((m) => {
            const st = monthlyStatement(db, m, month);
            return html`<tr class="${m.active ? '' : 'is-inactive'}">
              <td><strong>${m.name}</strong></td>
              <td>${m.email}${m.phone ? html`<br>${m.phone}` : ''}</td>
              <td class="num">${formatEUR(m.hourly_rate_cents)}</td>
              <td class="num">${formatEUR(m.monthly_fee_cents)}</td>
              <td class="num">${formatEUR(st.total)}<br><span class="small muted">${st.lessonCount} Termine</span></td>
              <td>${m.active ? 'aktiv' : 'inaktiv'}</td>
              <td class="actions">
                <a class="btn btn-ghost btn-sm" href="/admin/mitglieder/${m.id}">Bearbeiten</a>
                <a class="btn btn-ghost btn-sm" href="/admin/termine?mitglied=${m.id}">Termine</a>
                <a class="btn btn-ghost btn-sm" href="/admin/abrechnung/${m.id}?monat=${month}">Betrag</a>
              </td>
            </tr>`;
          })}</tbody></table></div>`}`,
    })));
  });

  function memberForm(req, { member, values, errors = [], leadId = null }) {
    const isNew = !member;
    const v = values;
    return layout(req, {
      title: isNew ? 'Neues Mitglied' : `Mitglied: ${member.name}`,
      body: html`
      <div class="page-head">
        <h1>${isNew ? 'Neues Mitglied anlegen' : `Mitglied bearbeiten: ${member.name}`}</h1>
        ${isNew ? '' : html`<div class="btn-row">
          <a class="btn btn-ghost" href="/admin/termine?mitglied=${member.id}">Termine</a>
          <a class="btn btn-ghost" href="/admin/abrechnung/${member.id}">Monatsbetrag</a>
        </div>`}
      </div>
      <section class="card">
        ${errorList(errors)}
        <form method="post" action="${isNew ? '/admin/mitglieder' : `/admin/mitglieder/${member.id}`}" class="form-grid">
          ${csrfField(req)}
          ${leadId ? html`<input type="hidden" name="lead_id" value="${leadId}">` : ''}
          <label>Name *<input name="name" required maxlength="120" value="${v.name || ''}"></label>
          <label>E-Mail (Login) *<input name="email" type="email" required maxlength="200" value="${v.email || ''}"></label>
          <label>Telefon<input name="phone" maxlength="50" value="${v.phone || ''}"></label>
          <label>${isNew ? 'Passwort * (mind. 8 Zeichen)' : 'Neues Passwort (leer lassen = unverändert)'}
            <input name="password" type="text" autocomplete="new-password" minlength="8" ${isNew ? 'required' : ''} value="${v.password || ''}">
          </label>
          <label>Preis pro Stunde (€)<input name="hourly_rate" inputmode="decimal" placeholder="z. B. 45,00" value="${v.hourly_rate || ''}"></label>
          <label>Monatliche Grundgebühr (€)<input name="monthly_fee" inputmode="decimal" placeholder="z. B. 0,00" value="${v.monthly_fee || ''}"></label>
          <label class="span-2">Interne Notizen<textarea name="notes" rows="3" maxlength="2000">${v.notes || ''}</textarea></label>
          <label class="check"><input type="checkbox" name="active" value="1"${v.active ? ' checked' : ''}><span>Aktiv (darf sich einloggen)</span></label>
          ${isNew ? '' : html`<label class="check"><input type="checkbox" name="reprice" value="1"><span>Preise aller künftigen Termine mit dem neuen Stundenpreis neu berechnen</span></label>`}
          <div class="span-2 btn-row"><button class="btn btn-primary" type="submit">Speichern</button>
            <a class="btn btn-ghost" href="/admin/mitglieder">Abbrechen</a></div>
        </form>
      </section>
      ${isNew ? '' : html`
      <section class="card danger-zone">
        <h2>Mitglied löschen</h2>
        <p class="muted">Löscht das Mitglied inklusive aller Termine und Posten. Alternativ kannst du es oben auf „inaktiv“ setzen.</p>
        <form method="post" action="/admin/mitglieder/${member.id}/loeschen" data-confirm="${member.name} mit allen Terminen endgültig löschen?">
          ${csrfField(req)}<button class="btn btn-danger" type="submit">Endgültig löschen</button>
        </form>
      </section>`}`,
    });
  }

  function readMemberForm(body, isNew) {
    const values = {
      name: str(body.name, 120),
      email: str(body.email, 200),
      phone: str(body.phone, 50),
      password: typeof body.password === 'string' ? body.password : '',
      hourly_rate: str(body.hourly_rate, 20),
      monthly_fee: str(body.monthly_fee, 20),
      notes: str(body.notes, 2000),
      active: body.active === '1',
    };
    const errors = [];
    if (!values.name) errors.push('Name fehlt.');
    if (!EMAIL_RE.test(values.email)) errors.push('Ungültige E-Mail-Adresse.');
    if ((isNew || values.password) && values.password.length < 8) errors.push('Passwort muss mindestens 8 Zeichen haben.');
    const rate = values.hourly_rate === '' ? 0 : parseEUR(values.hourly_rate);
    const fee = values.monthly_fee === '' ? 0 : parseEUR(values.monthly_fee);
    if (rate === null || rate < 0) errors.push('Ungültiger Stundenpreis.');
    if (fee === null || fee < 0) errors.push('Ungültige Grundgebühr.');
    return { values, errors, rate, fee };
  }

  function emailTaken(email, exceptId = 0) {
    return !!db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, exceptId);
  }

  router.get('/mitglieder/neu', (req, res) => {
    const leadId = toId(req.query.interessent);
    const lead = leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) : null;
    const values = {
      active: true,
      password: crypto.randomBytes(6).toString('base64url'),
      ...(lead ? { name: lead.name, email: lead.email, phone: lead.phone || '', notes: [lead.level, lead.availability, lead.message].filter(Boolean).join('\n') } : {}),
    };
    res.send(String(memberForm(req, { values, leadId: lead ? lead.id : null })));
  });

  router.post('/mitglieder', (req, res) => {
    const { values, errors, rate, fee } = readMemberForm(req.body, true);
    if (!errors.length && emailTaken(values.email)) errors.push('Diese E-Mail-Adresse wird bereits verwendet.');
    const leadId = toId(req.body.lead_id);
    if (errors.length) {
      res.status(400);
      return res.send(String(memberForm(req, { values, errors, leadId })));
    }
    const r = db
      .prepare(
        `INSERT INTO users (name, email, phone, password_hash, role, hourly_rate_cents, monthly_fee_cents, active, notes)
         VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)`
      )
      .run(values.name, values.email, values.phone || null, hashPassword(values.password), rate, fee, values.active ? 1 : 0, values.notes || null);
    if (leadId) {
      db.prepare("UPDATE leads SET status = 'Mitglied', converted_user_id = ? WHERE id = ?").run(r.lastInsertRowid, leadId);
    }
    res.flash('success', `Mitglied ${values.name} angelegt. Login: ${values.email} / Passwort: ${values.password}`);
    res.redirect(`/admin/mitglieder/${r.lastInsertRowid}`);
  });

  router.get('/mitglieder/:id', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'Mitglied');
    const values = {
      name: member.name,
      email: member.email,
      phone: member.phone || '',
      hourly_rate: centsToInput(member.hourly_rate_cents),
      monthly_fee: centsToInput(member.monthly_fee_cents),
      notes: member.notes || '',
      active: !!member.active,
    };
    res.send(String(memberForm(req, { member, values })));
  });

  router.post('/mitglieder/:id', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'Mitglied');
    const { values, errors, rate, fee } = readMemberForm(req.body, false);
    if (!errors.length && emailTaken(values.email, member.id)) errors.push('Diese E-Mail-Adresse wird bereits verwendet.');
    if (errors.length) {
      res.status(400);
      return res.send(String(memberForm(req, { member, values, errors })));
    }
    db.prepare(
      `UPDATE users SET name = ?, email = ?, phone = ?, hourly_rate_cents = ?, monthly_fee_cents = ?, active = ?, notes = ?
        WHERE id = ?`
    ).run(values.name, values.email, values.phone || null, rate, fee, values.active ? 1 : 0, values.notes || null, member.id);
    if (values.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(values.password), member.id);
    }
    if (req.body.reprice === '1') {
      db.prepare('UPDATE lessons SET price_cents = CAST(ROUND(? * duration_min / 60.0) AS INTEGER) WHERE user_id = ? AND date >= ?')
        .run(rate, member.id, D.todayISO());
    }
    res.flash('success', `Änderungen für ${values.name} gespeichert.${values.password ? ' Neues Passwort gesetzt.' : ''}`);
    res.redirect(`/admin/mitglieder/${member.id}`);
  });

  router.post('/mitglieder/:id/loeschen', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'Mitglied');
    db.prepare('DELETE FROM users WHERE id = ?').run(member.id);
    res.flash('success', `${member.name} wurde gelöscht.`);
    res.redirect('/admin/mitglieder');
  });

  // ---------------------------------------------------------------- Termine
  function lessonFields(req, v, members) {
    return html`
      <label>Mitglied *
        <select name="user_id" required>
          <option value="">– bitte wählen –</option>
          ${members.map((m) => html`<option value="${m.id}"${String(v.user_id) === String(m.id) ? ' selected' : ''}>${m.name} (${formatEUR(m.hourly_rate_cents)}/Std.)</option>`)}
        </select>
      </label>
      <label>Datum *<input name="date" type="date" required value="${v.date || ''}"></label>
      <label>Uhrzeit *<input name="start_time" type="time" required step="300" value="${v.start_time || ''}"></label>
      <label>Dauer *
        <select name="duration_min">${DURATIONS.map((d) => html`<option value="${d}"${Number(v.duration_min) === d ? ' selected' : ''}>${d} Minuten</option>`)}</select>
      </label>
      <label>Platz<input name="court" maxlength="30" value="${v.court || ''}"></label>
      <label>Preis (€)<input name="price" inputmode="decimal" placeholder="leer = aus Stundenpreis" value="${v.price || ''}"></label>
      <label class="span-2">Notiz (für das Mitglied sichtbar)<input name="note" maxlength="300" value="${v.note || ''}"></label>`;
  }

  function readLessonForm(body) {
    const v = {
      user_id: toId(body.user_id),
      date: str(body.date, 10),
      start_time: str(body.start_time, 5),
      duration_min: Number(body.duration_min),
      court: str(body.court, 30),
      note: str(body.note, 300),
      price: str(body.price, 20),
      cancelled: body.cancelled === '1',
      repeat: Math.max(1, Math.min(MAX_REPEAT_WEEKS, parseInt(body.repeat, 10) || 1)),
    };
    const errors = [];
    const member = v.user_id ? getMember.get(v.user_id) : null;
    if (!member) errors.push('Bitte ein Mitglied auswählen.');
    if (!D.isValidDate(v.date)) errors.push('Ungültiges Datum.');
    if (!D.isValidTime(v.start_time)) errors.push('Ungültige Uhrzeit.');
    if (!DURATIONS.includes(v.duration_min)) errors.push('Ungültige Dauer.');
    let price = null;
    if (v.price !== '') {
      price = parseEUR(v.price);
      if (price === null || price < 0) errors.push('Ungültiger Preis.');
    } else if (member) {
      price = lessonPrice(member.hourly_rate_cents, v.duration_min);
    }
    return { v, errors, member, price };
  }

  router.get('/termine', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(D.isValidDate(req.query.woche) ? req.query.woche : today);
    const memberFilter = toId(req.query.mitglied);
    const filterMember = memberFilter ? getMember.get(memberFilter) : null;
    const params = [monday, D.addDays(monday, 6)];
    let sql = `SELECT l.*, u.name AS member_name FROM lessons l JOIN users u ON u.id = l.user_id
               WHERE l.date BETWEEN ? AND ?`;
    if (filterMember) {
      sql += ' AND l.user_id = ?';
      params.push(filterMember.id);
    }
    const lessons = db.prepare(`${sql} ORDER BY l.date, l.start_time`).all(...params);
    const members = activeMembers.all();
    const extraQuery = filterMember ? `&mitglied=${filterMember.id}` : '';
    const defaults = { user_id: filterMember ? filterMember.id : '', date: monday < today && today <= D.addDays(monday, 6) ? today : monday, start_time: '17:00', duration_min: 60 };

    res.send(String(layout(req, {
      title: 'Termine',
      wide: true,
      body: html`
      <div class="page-head">
        <h1>Termine${filterMember ? ` – ${filterMember.name}` : ''}</h1>
        <form method="get" action="/admin/termine" class="inline">
          <input type="hidden" name="woche" value="${monday}">
          <select name="mitglied" aria-label="Nach Mitglied filtern">
            <option value="">Alle Mitglieder</option>
            ${allMembers.all().map((m) => html`<option value="${m.id}"${filterMember && filterMember.id === m.id ? ' selected' : ''}>${m.name}</option>`)}
          </select>
          <button class="btn btn-ghost btn-sm" type="submit">Filtern</button>
        </form>
      </div>
      ${weekView({ monday, lessons, baseUrl: '/admin/termine', today, linkLesson: (l) => `/admin/termine/${l.id}`, showPrice: true, extraQuery })}
      <section class="card">
        <h2>Neuen Termin anlegen</h2>
        ${members.length === 0
          ? html`<p class="muted">Lege zuerst ein <a href="/admin/mitglieder/neu">Mitglied</a> an.</p>`
          : html`<form method="post" action="/admin/termine" class="form-grid">
            ${csrfField(req)}
            ${lessonFields(req, defaults, members)}
            <label>Wiederholen
              <select name="repeat">
                <option value="1">Einmalig</option>
                ${[4, 8, 12, 16, 26, 52].map((n) => html`<option value="${n}">Wöchentlich, ${n} Wochen</option>`)}
              </select>
            </label>
            <div class="span-2"><button class="btn btn-primary" type="submit">Termin speichern</button></div>
          </form>`}
      </section>`,
    })));
  });

  router.post('/termine', (req, res) => {
    const { v, errors, member, price } = readLessonForm(req.body);
    if (errors.length) {
      res.flash('error', errors.join(' '));
      return res.redirect(`/admin/termine${D.isValidDate(v.date) ? `?woche=${D.mondayOf(v.date)}` : ''}`);
    }
    const insert = db.prepare(
      'INSERT INTO lessons (user_id, date, start_time, duration_min, court, note, price_cents) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      for (let i = 0; i < v.repeat; i++) {
        insert.run(member.id, D.addDays(v.date, 7 * i), v.start_time, v.duration_min, v.court || null, v.note || null, price);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.flash('success', v.repeat > 1
      ? `${v.repeat} wöchentliche Termine für ${member.name} angelegt (ab ${D.formatDateLong(v.date)}).`
      : `Termin für ${member.name} am ${D.formatDateLong(v.date)} angelegt.`);
    res.redirect(`/admin/termine?woche=${D.mondayOf(v.date)}`);
  });

  router.get('/termine/:id', (req, res) => {
    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(toId(req.params.id));
    if (!lesson) return notFound(res, 'Termin');
    const values = { ...lesson, price: centsToInput(lesson.price_cents) };
    res.send(String(lessonEditPage(req, lesson, values)));
  });

  function lessonEditPage(req, lesson, values, errors = []) {
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(lesson.user_id);
    const members = activeMembers.all();
    if (owner && !members.some((m) => m.id === owner.id)) members.unshift(owner);
    return layout(req, {
      title: 'Termin bearbeiten',
      body: html`
      <div class="page-head"><h1>Termin bearbeiten</h1>
        <a class="btn btn-ghost" href="/admin/termine?woche=${D.mondayOf(lesson.date)}">← Zur Woche</a></div>
      <section class="card">
        ${errorList(errors)}
        <form method="post" action="/admin/termine/${lesson.id}" class="form-grid">
          ${csrfField(req)}
          ${lessonFields(req, values, members)}
          <label class="check span-2"><input type="checkbox" name="cancelled" value="1"${values.cancelled ? ' checked' : ''}>
            <span>Abgesagt (wird nicht berechnet)</span></label>
          <div class="span-2 btn-row"><button class="btn btn-primary" type="submit">Speichern</button></div>
        </form>
      </section>
      <section class="card danger-zone">
        <form method="post" action="/admin/termine/${lesson.id}/loeschen" data-confirm="Termin endgültig löschen?">
          ${csrfField(req)}<button class="btn btn-danger" type="submit">Termin löschen</button>
        </form>
      </section>`,
    });
  }

  router.post('/termine/:id', (req, res) => {
    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(toId(req.params.id));
    if (!lesson) return notFound(res, 'Termin');
    const { v, errors, member, price } = readLessonForm(req.body);
    if (errors.length) {
      res.status(400);
      return res.send(String(lessonEditPage(req, lesson, v, errors)));
    }
    db.prepare(
      `UPDATE lessons SET user_id = ?, date = ?, start_time = ?, duration_min = ?, court = ?, note = ?, price_cents = ?, cancelled = ?
        WHERE id = ?`
    ).run(member.id, v.date, v.start_time, v.duration_min, v.court || null, v.note || null, price, v.cancelled ? 1 : 0, lesson.id);
    res.flash('success', 'Termin gespeichert.');
    res.redirect(`/admin/termine?woche=${D.mondayOf(v.date)}`);
  });

  router.post('/termine/:id/loeschen', (req, res) => {
    const lesson = db.prepare('SELECT * FROM lessons WHERE id = ?').get(toId(req.params.id));
    if (!lesson) return notFound(res, 'Termin');
    db.prepare('DELETE FROM lessons WHERE id = ?').run(lesson.id);
    res.flash('success', 'Termin gelöscht.');
    res.redirect(`/admin/termine?woche=${D.mondayOf(lesson.date)}`);
  });

  // ---------------------------------------------------------------- Beträge
  router.get('/abrechnung', (req, res) => {
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const rows = allMembers.all().map((m) => ({ member: m, st: monthlyStatement(db, m, month) }))
      .filter((r) => r.member.active || r.st.total !== 0);
    const sum = rows.reduce((s, r) => s + r.st.total, 0);

    res.send(String(layout(req, {
      title: 'Beträge',
      wide: true,
      body: html`
      <div class="page-head"><h1>Monatsbeträge</h1></div>
      ${monthNav('/admin/abrechnung', month)}
      <div class="table-wrap"><table>
        <thead><tr><th>Mitglied</th><th class="num">Termine</th><th class="num">Stunden</th><th class="num">Grundgebühr</th><th class="num">Trainings</th><th class="num">Posten</th><th class="num">Summe</th><th></th></tr></thead>
        <tbody>${rows.length === 0
          ? html`<tr><td colspan="8" class="empty">Keine Mitglieder.</td></tr>`
          : rows.map(({ member: m, st }) => html`<tr class="${m.active ? '' : 'is-inactive'}">
            <td><strong>${m.name}</strong></td>
            <td class="num">${st.lessonCount}</td>
            <td class="num">${formatHours(st.hours)}</td>
            <td class="num">${formatEUR(st.fee)}</td>
            <td class="num">${formatEUR(st.lessonsTotal)}</td>
            <td class="num">${formatEUR(st.adjustmentsTotal)}</td>
            <td class="num"><strong>${formatEUR(st.total)}</strong></td>
            <td class="actions"><a class="btn btn-ghost btn-sm" href="/admin/abrechnung/${m.id}?monat=${month}">Details</a></td>
          </tr>`)}</tbody>
        <tfoot><tr class="total"><td colspan="6">Gesamt ${D.monthLabel(month)}</td><td class="num">${formatEUR(sum)}</td><td></td></tr></tfoot>
      </table></div>
      <p class="muted small">Die Beträge werden den Mitgliedern nur zur Information angezeigt. Es findet keine Zahlungsabwicklung statt.</p>`,
    })));
  });

  router.get('/abrechnung/:id', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'Mitglied');
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const st = monthlyStatement(db, member, month);
    res.send(String(layout(req, {
      title: `Betrag ${member.name}`,
      body: html`
      <div class="page-head">
        <h1>Monatsbetrag: ${member.name}</h1>
        <a class="btn btn-ghost" href="/admin/mitglieder/${member.id}">Mitglied bearbeiten</a>
      </div>
      ${monthNav(`/admin/abrechnung/${member.id}`, month)}
      <div class="summary-tile big">
        <span class="label">Summe ${D.monthLabel(month)} (so sieht es das Mitglied)</span>
        <span class="value">${formatEUR(st.total)}</span>
        <span class="hint">${formatEUR(member.hourly_rate_cents)} pro Stunde · Grundgebühr ${formatEUR(member.monthly_fee_cents)}</span>
      </div>
      ${statementTable(st, { adminDelete: true, req })}
      <section class="card">
        <h2>Posten hinzufügen</h2>
        <p class="muted small">Z. B. Ballmaschine, Platzmiete, Rabatt. Negative Beträge sind Gutschriften.
          Trainingspreise änderst du direkt am <a href="/admin/termine?mitglied=${member.id}">Termin</a>.</p>
        <form method="post" action="/admin/abrechnung/${member.id}/posten" class="form-grid">
          ${csrfField(req)}
          <input type="hidden" name="month" value="${month}">
          <label>Beschreibung *<input name="description" required maxlength="200"></label>
          <label>Betrag (€) *<input name="amount" required inputmode="decimal" placeholder="z. B. 15,00 oder -10,00"></label>
          <div class="span-2"><button class="btn btn-primary" type="submit">Posten hinzufügen</button></div>
        </form>
      </section>`,
    })));
  });

  router.post('/abrechnung/:id/posten', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'Mitglied');
    const month = D.isValidMonth(req.body.month) ? req.body.month : D.monthOf(D.todayISO());
    const description = str(req.body.description, 200);
    const amount = parseEUR(req.body.amount);
    if (!description || amount === null) {
      res.flash('error', 'Bitte Beschreibung und einen gültigen Betrag angeben.');
    } else {
      db.prepare('INSERT INTO adjustments (user_id, month, description, amount_cents) VALUES (?, ?, ?, ?)')
        .run(member.id, month, description, amount);
      res.flash('success', 'Posten hinzugefügt.');
    }
    res.redirect(`/admin/abrechnung/${member.id}?monat=${month}`);
  });

  router.post('/posten/:id/loeschen', (req, res) => {
    const adj = db.prepare('SELECT * FROM adjustments WHERE id = ?').get(toId(req.params.id));
    if (!adj) return notFound(res, 'Posten');
    db.prepare('DELETE FROM adjustments WHERE id = ?').run(adj.id);
    res.flash('success', 'Posten gelöscht.');
    res.redirect(`/admin/abrechnung/${adj.user_id}?monat=${adj.month}`);
  });

  return router;
};
