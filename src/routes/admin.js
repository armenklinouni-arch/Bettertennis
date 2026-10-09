'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney, centsToInput, parseMoney, lessonPrice, CURRENCY_SYMBOL } = require('../money');
const {
  monthlyStatement, setPaid, setReleased, formatHours, BILLING_MODES, BILLING_MODE_SHORT, MEMBER_MONTHS_BACK,
} = require('../billing');
const {
  layout, csrfField, errorList, weekView, statementTable, monthNav, paymentBadge, releaseBadge, lessonTimeRange, lessonTags, LESSON_KINDS, LESSON_STATUSES,
} = require('../views');
const { requireAdmin, hashPassword } = require('../auth');
const { EMAIL_RE, str } = require('./public');
const { listGroupsWithMembers } = require('./groups');

const LEAD_STATUSES = ['novo', 'kontaktiran', 'probni trening', 'član', 'odbijen'];
const DURATIONS = [30, 45, 60, 90, 120];
const MAX_REPEAT_WEEKS = 52;
const GROUP_MIN = 2; // grupni trening: najmanje 2 …
const GROUP_MAX = 8; // … i najviše 8 članova

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
  const activeTrainers = db.prepare('SELECT * FROM trainers WHERE active = 1 ORDER BY name COLLATE NOCASE');
  const getTrainer = db.prepare('SELECT * FROM trainers WHERE id = ?');

  function notFound(res, what = 'Zapis') {
    res.status(404);
    return res.send(`Nije pronađeno: ${what}.`);
  }

  // ---------------------------------------------------------------- Pregled
  router.get('/', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(today);
    const month = D.monthOf(today);
    const newLeads = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'novo'").get().n;
    const memberCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member' AND active = 1").get().n;
    const weekCount = db
      .prepare("SELECT COUNT(DISTINCT COALESCE(group_id, 'L' || id)) AS n FROM lessons WHERE cancelled = 0 AND date BETWEEN ? AND ?")
      .get(monday, D.addDays(monday, 6)).n;
    const monthTotal = activeMembers.all().reduce((sum, m) => sum + monthlyStatement(db, m, month).total, 0);
    const todays = mergeGroups(db
      .prepare(
        `SELECT l.*, u.name AS member_name, t.name AS trainer_name FROM lessons l
           JOIN users u ON u.id = l.user_id LEFT JOIN trainers t ON t.id = l.trainer_id
          WHERE l.date = ? ORDER BY l.start_time, l.id`
      )
      .all(today));
    const latestLeads = db.prepare("SELECT * FROM leads WHERE status = 'novo' ORDER BY id DESC LIMIT 5").all();

    res.send(String(layout(req, {
      title: 'Admin',
      body: html`
      <h1>Upravljanje</h1>
      <div class="tiles">
        <a class="summary-tile" href="/admin/interessenten"><span class="label">Novi zainteresovani</span><span class="value">${newLeads}</span></a>
        <a class="summary-tile" href="/admin/mitglieder"><span class="label">Aktivni članovi</span><span class="value">${memberCount}</span></a>
        <a class="summary-tile" href="/admin/termine"><span class="label">Termini ove sedmice</span><span class="value">${weekCount}</span></a>
        <a class="summary-tile" href="/admin/abrechnung?monat=${month}"><span class="label">Ukupno ${D.monthLabel(month)}</span><span class="value">${formatMoney(monthTotal)}</span></a>
      </div>
      <div class="two-col">
        <section class="card">
          <h2>Danas, ${D.formatDateLong(today)}</h2>
          ${todays.length === 0
            ? html`<p class="muted">Danas nema treninga.</p>`
            : html`<ul class="list">${todays.map((l) => html`
                <li class="${l.cancelled ? 'is-cancelled' : ''}"><strong>${lessonTimeRange(l)}</strong> · ${l.member_name}
                  ${l.court ? html`· Teren ${l.court}` : ''} <a href="/admin/termine/${l.id}">uredi</a>
                  ${lessonTags(l)}</li>`)}</ul>`}
        </section>
        <section class="card">
          <h2>Novi upiti</h2>
          ${latestLeads.length === 0
            ? html`<p class="muted">Nema novih upita.</p>`
            : html`<ul class="list">${latestLeads.map((l) => html`
                <li><strong>${l.name}</strong> · ${l.level || ''} · <a href="mailto:${l.email}">${l.email}</a></li>`)}</ul>
              <a href="/admin/interessenten">Pogledaj sve zainteresovane →</a>`}
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
      title: 'Zainteresovani',
      wide: true,
      body: html`
      <div class="page-head"><h1>Zainteresovani</h1></div>
      <nav class="filters" aria-label="Filter">
        <a href="/admin/interessenten" class="${filter ? '' : 'active'}">Svi</a>
        ${LEAD_STATUSES.map((s) => html`<a href="/admin/interessenten?status=${encodeURIComponent(s)}" class="${filter === s ? 'active' : ''}">${s}</a>`)}
      </nav>
      ${leads.length === 0
        ? html`<p class="card muted">Nema zapisa.</p>`
        : html`<div class="table-wrap"><table>
          <thead><tr><th>Primljeno</th><th>Ime / kontakt</th><th>Nivo</th><th>Termini / poruka</th><th>Status</th><th></th></tr></thead>
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
                  ? html`<a class="btn btn-ghost btn-sm" href="/admin/mitglieder/${l.converted_user_id}">Do člana</a>`
                  : html`<a class="btn btn-primary btn-sm" href="/admin/mitglieder/neu?interessent=${l.id}">Kreiraj člana</a>`}
                <form method="post" action="/admin/interessenten/${l.id}/loeschen" data-confirm="Obrisati upit od: ${l.name}?">
                  ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
                </form>
              </td>
            </tr>`)}</tbody></table></div>`}`,
    })));
  });

  router.post('/interessenten/:id/status', (req, res) => {
    const status = req.body.status;
    if (!LEAD_STATUSES.includes(status)) return res.status(400).send('Neispravan status.');
    const r = db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, toId(req.params.id));
    if (!r.changes) return notFound(res, 'upit');
    res.flash('success', 'Status je ažuriran.');
    res.redirect('/admin/interessenten');
  });

  router.post('/interessenten/:id/loeschen', (req, res) => {
    db.prepare('DELETE FROM leads WHERE id = ?').run(toId(req.params.id));
    res.flash('success', 'Upit je obrisan.');
    res.redirect('/admin/interessenten');
  });

  // ---------------------------------------------------------------- Članovi
  router.get('/mitglieder', (req, res) => {
    const month = D.monthOf(D.todayISO());
    const members = allMembers.all();
    res.send(String(layout(req, {
      title: 'Članovi',
      wide: true,
      body: html`
      <div class="page-head">
        <h1>Članovi</h1>
        <a class="btn btn-primary" href="/admin/mitglieder/neu">+ Novi član</a>
      </div>
      ${members.length === 0
        ? html`<p class="card muted">Još nema kreiranih članova.</p>`
        : html`<div class="table-wrap"><table>
          <thead><tr><th>Ime</th><th>Kontakt</th><th class="num">Cijena / sat</th><th class="num">Članarina</th><th class="num">${D.monthLabel(month)}</th><th>Status</th><th></th></tr></thead>
          <tbody>${members.map((m) => {
            const st = monthlyStatement(db, m, month);
            return html`<tr class="${m.active ? '' : 'is-inactive'}">
              <td><strong>${m.name}</strong></td>
              <td>${m.email}${m.phone ? html`<br>${m.phone}` : ''}</td>
              <td class="num">${formatMoney(m.hourly_rate_cents)}</td>
              <td class="num">${formatMoney(m.monthly_fee_cents)}</td>
              <td class="num">${formatMoney(st.total)}<br><span class="small muted">${st.manual ? BILLING_MODE_SHORT.manual : `Termini: ${st.lessonCount}`}</span> ${paymentBadge(st)}</td>
              <td>${m.active ? 'aktivan' : 'neaktivan'}</td>
              <td class="actions">
                <a class="btn btn-ghost btn-sm" href="/admin/mitglieder/${m.id}">Uredi</a>
                <a class="btn btn-ghost btn-sm" href="/admin/termine?mitglied=${m.id}">Termini</a>
                <a class="btn btn-ghost btn-sm" href="/admin/abrechnung/${m.id}?monat=${month}">Iznos</a>
              </td>
            </tr>`;
          })}</tbody></table></div>`}`,
    })));
  });

  function memberForm(req, { member, values, errors = [], leadId = null }) {
    const isNew = !member;
    const v = values;
    return layout(req, {
      title: isNew ? 'Novi član' : `Član: ${member.name}`,
      body: html`
      <div class="page-head">
        <h1>${isNew ? 'Kreiraj novog člana' : `Uredi člana: ${member.name}`}</h1>
        ${isNew ? '' : html`<div class="btn-row">
          <a class="btn btn-ghost" href="/admin/termine?mitglied=${member.id}">Termini</a>
          <a class="btn btn-ghost" href="/admin/abrechnung/${member.id}">Mjesečni iznos</a>
        </div>`}
      </div>
      <section class="card">
        ${errorList(errors)}
        <form method="post" action="${isNew ? '/admin/mitglieder' : `/admin/mitglieder/${member.id}`}" class="form-grid">
          ${csrfField(req)}
          ${leadId ? html`<input type="hidden" name="lead_id" value="${leadId}">` : ''}
          <label>Ime i prezime *<input name="name" required maxlength="120" value="${v.name || ''}"></label>
          <label>E-mail (za prijavu) *<input name="email" type="email" required maxlength="200" value="${v.email || ''}"></label>
          <label>Telefon<input name="phone" maxlength="50" value="${v.phone || ''}"></label>
          <label>${isNew ? 'Lozinka * (najmanje 8 znakova)' : 'Nova lozinka (ostavi prazno = bez promjene)'}
            <input name="password" type="text" autocomplete="new-password" minlength="8" ${isNew ? 'required' : ''} value="${v.password || ''}">
          </label>
          <label>Cijena po satu (${CURRENCY_SYMBOL})<input name="hourly_rate" inputmode="decimal" placeholder="npr. 45,00" value="${v.hourly_rate || ''}"></label>
          <label>Mjesečna članarina (${CURRENCY_SYMBOL})<input name="monthly_fee" inputmode="decimal" placeholder="npr. 0,00" value="${v.monthly_fee || ''}"></label>
          <label class="span-2">Način obračuna
            <select name="billing_mode">
              ${Object.entries(BILLING_MODES).map(([k, label]) => html`<option value="${k}"${v.billing_mode === k ? ' selected' : ''}>${label}</option>`)}
            </select>
          </label>
          <label class="span-2">Interne bilješke<textarea name="notes" rows="3" maxlength="2000">${v.notes || ''}</textarea></label>
          <label class="check"><input type="checkbox" name="active" value="1"${v.active ? ' checked' : ''}><span>Aktivan (smije se prijaviti)</span></label>
          ${isNew ? '' : html`<label class="check"><input type="checkbox" name="reprice" value="1"><span>Ponovo izračunaj cijene svih budućih termina prema novoj cijeni po satu</span></label>`}
          <div class="span-2 btn-row"><button class="btn btn-primary" type="submit">Sačuvaj</button>
            <a class="btn btn-ghost" href="/admin/mitglieder">Odustani</a></div>
        </form>
      </section>
      ${isNew ? '' : html`
      <section class="card danger-zone">
        <h2>Brisanje člana</h2>
        <p class="muted">Briše člana zajedno sa svim terminima i stavkama. Umjesto toga ga možeš gore označiti kao „neaktivan“.</p>
        <form method="post" action="/admin/mitglieder/${member.id}/loeschen" data-confirm="Trajno obrisati člana ${member.name} sa svim terminima?">
          ${csrfField(req)}<button class="btn btn-danger" type="submit">Trajno obriši</button>
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
      billing_mode: BILLING_MODES[body.billing_mode] ? body.billing_mode : 'schedule',
    };
    const errors = [];
    if (!values.name) errors.push('Nedostaje ime.');
    if (!EMAIL_RE.test(values.email)) errors.push('Neispravna e-mail adresa.');
    if ((isNew || values.password) && values.password.length < 8) errors.push('Lozinka mora imati najmanje 8 znakova.');
    const rate = values.hourly_rate === '' ? 0 : parseMoney(values.hourly_rate);
    const fee = values.monthly_fee === '' ? 0 : parseMoney(values.monthly_fee);
    if (rate === null || rate < 0) errors.push('Neispravna cijena po satu.');
    if (fee === null || fee < 0) errors.push('Neispravna članarina.');
    return { values, errors, rate, fee };
  }

  function emailTaken(email, exceptId = 0) {
    return !!db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(email, exceptId)
      || !!db.prepare('SELECT id FROM trainers WHERE email = ? COLLATE NOCASE').get(email);
  }

  router.get('/mitglieder/neu', (req, res) => {
    const leadId = toId(req.query.interessent);
    const lead = leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) : null;
    const values = {
      active: true,
      billing_mode: 'schedule',
      password: crypto.randomBytes(6).toString('base64url'),
      ...(lead ? { name: lead.name, email: lead.email, phone: lead.phone || '', notes: [lead.level, lead.availability, lead.message].filter(Boolean).join('\n') } : {}),
    };
    res.send(String(memberForm(req, { values, leadId: lead ? lead.id : null })));
  });

  router.post('/mitglieder', (req, res) => {
    const { values, errors, rate, fee } = readMemberForm(req.body, true);
    if (!errors.length && emailTaken(values.email)) errors.push('Ova e-mail adresa se već koristi.');
    const leadId = toId(req.body.lead_id);
    if (errors.length) {
      res.status(400);
      return res.send(String(memberForm(req, { values, errors, leadId })));
    }
    const r = db
      .prepare(
        `INSERT INTO users (name, email, phone, password_hash, role, hourly_rate_cents, monthly_fee_cents, active, notes, billing_mode)
         VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?, ?)`
      )
      .run(values.name, values.email, values.phone || null, hashPassword(values.password), rate, fee, values.active ? 1 : 0, values.notes || null, values.billing_mode);
    if (leadId) {
      db.prepare("UPDATE leads SET status = 'član', converted_user_id = ? WHERE id = ?").run(r.lastInsertRowid, leadId);
    }
    res.flash('success', `Član ${values.name} je kreiran. Prijava: ${values.email} / lozinka: ${values.password}`);
    res.redirect(`/admin/mitglieder/${r.lastInsertRowid}`);
  });

  router.get('/mitglieder/:id', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'član');
    const values = {
      name: member.name,
      email: member.email,
      phone: member.phone || '',
      hourly_rate: centsToInput(member.hourly_rate_cents),
      monthly_fee: centsToInput(member.monthly_fee_cents),
      notes: member.notes || '',
      active: !!member.active,
      billing_mode: member.billing_mode,
    };
    res.send(String(memberForm(req, { member, values })));
  });

  router.post('/mitglieder/:id', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'član');
    const { values, errors, rate, fee } = readMemberForm(req.body, false);
    if (!errors.length && emailTaken(values.email, member.id)) errors.push('Ova e-mail adresa se već koristi.');
    if (errors.length) {
      res.status(400);
      return res.send(String(memberForm(req, { member, values, errors })));
    }
    db.prepare(
      `UPDATE users SET name = ?, email = ?, phone = ?, hourly_rate_cents = ?, monthly_fee_cents = ?, active = ?, notes = ?, billing_mode = ?
        WHERE id = ?`
    ).run(values.name, values.email, values.phone || null, rate, fee, values.active ? 1 : 0, values.notes || null, values.billing_mode, member.id);
    if (values.password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(values.password), member.id);
    }
    if (req.body.reprice === '1') {
      db.prepare('UPDATE lessons SET price_cents = CAST(ROUND(? * duration_min / 60.0) AS INTEGER) WHERE user_id = ? AND date >= ?')
        .run(rate, member.id, D.todayISO());
    }
    res.flash('success', `Promjene za ${values.name} su sačuvane.${values.password ? ' Nova lozinka je postavljena.' : ''}`);
    res.redirect(`/admin/mitglieder/${member.id}`);
  });

  router.post('/mitglieder/:id/loeschen', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'član');
    db.prepare('DELETE FROM users WHERE id = ?').run(member.id);
    res.flash('success', `${member.name} je obrisan/a.`);
    res.redirect('/admin/mitglieder');
  });

  // ---------------------------------------------------------------- Termini
  // Grupni trening se čuva kao po jedan red za svakog člana s istim group_id.
  // Tako svaki član u svom rasporedu i obračunu vidi samo sebe, a admin vidi cijelu grupu.

  const getLesson = db.prepare('SELECT * FROM lessons WHERE id = ?');
  const groupRows = db.prepare('SELECT * FROM lessons WHERE group_id = ? ORDER BY id');
  const insertLesson = db.prepare(
    `INSERT INTO lessons (user_id, date, start_time, duration_min, court, note, price_cents, cancelled, kind, group_id, trainer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const deleteLesson = db.prepare('DELETE FROM lessons WHERE id = ?');

  function lessonSet(lesson) {
    return lesson.group_id ? groupRows.all(lesson.group_id) : [lesson];
  }

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // Spaja redove istog grupnog treninga u jedan prikaz s imenima svih članova.
  function mergeGroups(rows) {
    const out = [];
    const byGroup = new Map();
    for (const r of rows) {
      const existing = r.group_id && byGroup.get(r.group_id);
      if (existing) {
        existing.member_name = `${existing.member_name}, ${r.member_name}`;
        continue;
      }
      const item = { ...r };
      if (r.group_id) byGroup.set(r.group_id, item);
      out.push(item);
    }
    return out;
  }

  // Aktivni treneri + trener koji je već na terminu (i ako je u međuvremenu neaktivan).
  function trainerOptions(selected) {
    const trainers = activeTrainers.all();
    const current = selected ? getTrainer.get(selected) : null;
    if (current && !trainers.some((t) => t.id === current.id)) trainers.unshift(current);
    return trainers.map((t) => html`<option value="${t.id}"${String(selected) === String(t.id) ? ' selected' : ''}>${t.name}</option>`);
  }

  // Izbor stalne grupe: JavaScript (public/app.js) označi njene članove u formularu.
  function groupPicker() {
    const groups = listGroupsWithMembers(db, { activeOnly: true }).filter((g) => g.members.length > 0);
    if (groups.length === 0) {
      return html`<p class="muted small span-2">Savjet: stalne grupe igrača možeš unaprijed kreirati pod <a href="/admin/grupe">Grupe</a>.</p>`;
    }
    return html`
      <label class="span-2">Stalna grupa (automatski označi članove)
        <select name="preset_group" class="group-preset">
          <option value="">– bez stalne grupe –</option>
          ${groups.map((g) => html`<option value="${g.id}" data-members="${g.members.map((m) => m.id).join(',')}">${g.name}: ${g.members.map((m) => m.name).join(', ')}</option>`)}
        </select>
      </label>`;
  }

  function lessonFields(req, v, members, { withStatus = false } = {}) {
    const memberOptions = (selected) =>
      members.map((m) => html`<option value="${m.id}"${String(selected) === String(m.id) ? ' selected' : ''}>${m.name} (${formatMoney(m.hourly_rate_cents)}/h)</option>`);
    return html`
      <label>Vrsta treninga *
        <select name="kind">
          ${Object.entries(LESSON_KINDS).map(([k, label]) => html`<option value="${k}"${v.kind === k ? ' selected' : ''}>${label}</option>`)}
        </select>
      </label>
      ${withStatus
        ? html`<label>Status
            <select name="status">
              ${Object.entries(LESSON_STATUSES).map(([k, label]) => html`<option value="${k}"${(v.cancelled ? 'cancelled' : 'done') === k ? ' selected' : ''}>${label}${k === 'cancelled' ? ' (ne naplaćuje se)' : ''}</option>`)}
            </select>
          </label>`
        : html`<p class="muted small form-hint">Novi termin automatski dobija status „${LESSON_STATUSES.done}“. Status možeš kasnije promijeniti u „${LESSON_STATUSES.cancelled}“.</p>`}
      ${groupPicker()}
      <label>Trener
        <select name="trainer_id">
          <option value="">– bez trenera –</option>
          ${trainerOptions(v.trainer_id)}
        </select>
      </label>
      <label>Član (za individualni trening)
        <select name="user_id">
          <option value="">– odaberi –</option>
          ${memberOptions(v.user_id)}
        </select>
      </label>
      <fieldset class="span-2 recipients group-members">
        <legend>Igrači u grupi (za grupni trening označi ${GROUP_MIN}–${GROUP_MAX} igrača)</legend>
        <div class="recipient-list">
          ${members.map((m) => html`<label class="check"><input type="checkbox" name="member_ids" value="${m.id}"${(v.member_ids || []).map(String).includes(String(m.id)) ? ' checked' : ''}><span>${m.name}</span></label>`)}
        </div>
      </fieldset>
      <label>Datum *<input name="date" type="date" required value="${v.date || ''}"></label>
      <label>Vrijeme *<input name="start_time" type="time" required step="300" value="${v.start_time || ''}"></label>
      <label>Trajanje *
        <select name="duration_min">${DURATIONS.map((d) => html`<option value="${d}"${Number(v.duration_min) === d ? ' selected' : ''}>${d} minuta</option>`)}</select>
      </label>
      <label>Teren<input name="court" maxlength="30" value="${v.court || ''}"></label>
      <label>Cijena po osobi (${CURRENCY_SYMBOL})<input name="price" inputmode="decimal" placeholder="prazno = prema cijeni po satu" value="${v.price || ''}"></label>
      <label>Napomena (vidljiva članu)<input name="note" maxlength="300" value="${v.note || ''}"></label>`;
  }

  function readLessonForm(body) {
    const v = {
      kind: body.kind === 'group' ? 'group' : 'individual',
      user_id: toId(body.user_id),
      trainer_id: toId(body.trainer_id),
      member_ids: (Array.isArray(body.member_ids) ? body.member_ids : body.member_ids ? [body.member_ids] : [])
        .map(toId).filter(Boolean),
      date: str(body.date, 10),
      start_time: str(body.start_time, 5),
      duration_min: Number(body.duration_min),
      court: str(body.court, 30),
      note: str(body.note, 300),
      price: str(body.price, 20),
      cancelled: body.status === 'cancelled',
      repeat: Math.max(1, Math.min(MAX_REPEAT_WEEKS, parseInt(body.repeat, 10) || 1)),
    };
    const errors = [];
    const members = [];
    if (v.kind === 'group') {
      // Grupni trening: svi označeni igrači (kvačice); polje „Član“ se dodaje ako je popunjeno.
      const ids = [...new Set([...(v.user_id ? [v.user_id] : []), ...v.member_ids])];
      for (const id of ids) {
        const m = getMember.get(id);
        if (m) members.push(m);
      }
      if (members.length < GROUP_MIN) errors.push(`Za grupni trening označi najmanje ${GROUP_MIN} igrača.`);
      if (members.length > GROUP_MAX) errors.push(`Grupni trening može imati najviše ${GROUP_MAX} igrača.`);
    } else {
      const first = v.user_id ? getMember.get(v.user_id) : null;
      if (!first) errors.push('Za individualni trening odaberi člana.');
      else members.push(first);
    }
    if (v.trainer_id && !getTrainer.get(v.trainer_id)) errors.push('Odabrani trener ne postoji.');
    if (!D.isValidDate(v.date)) errors.push('Neispravan datum.');
    if (!D.isValidTime(v.start_time)) errors.push('Neispravno vrijeme.');
    if (!DURATIONS.includes(v.duration_min)) errors.push('Neispravno trajanje.');
    let fixedPrice = null;
    if (v.price !== '') {
      fixedPrice = parseMoney(v.price);
      if (fixedPrice === null || fixedPrice < 0) errors.push('Neispravna cijena.');
    }
    // Bez unesene cijene svaki član plaća prema svojoj cijeni po satu.
    const participants = members.map((m) => ({
      member: m,
      price: fixedPrice !== null ? fixedPrice : lessonPrice(m.hourly_rate_cents, v.duration_min),
    }));
    return { v, errors, participants };
  }

  function insertOccurrence(v, participants, date, groupId = null) {
    const gid = v.kind === 'group' ? groupId || crypto.randomUUID() : null;
    for (const p of participants) {
      insertLesson.run(p.member.id, date, v.start_time, v.duration_min, v.court || null, v.note || null, p.price, v.cancelled ? 1 : 0, v.kind, gid, v.trainer_id);
    }
  }

  function participantNames(participants) {
    return participants.map((p) => p.member.name).join(', ');
  }

  router.get('/termine', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(D.isValidDate(req.query.woche) ? req.query.woche : today);
    const memberFilter = toId(req.query.mitglied);
    const filterMember = memberFilter ? getMember.get(memberFilter) : null;
    const params = [monday, D.addDays(monday, 6)];
    let sql = `SELECT l.*, u.name AS member_name, t.name AS trainer_name FROM lessons l
               JOIN users u ON u.id = l.user_id LEFT JOIN trainers t ON t.id = l.trainer_id
               WHERE l.date BETWEEN ? AND ?`;
    if (filterMember) {
      // Uz termine člana prikazujemo i ostale članove njegovih grupa.
      sql += ' AND (l.user_id = ? OR l.group_id IN (SELECT group_id FROM lessons WHERE user_id = ? AND group_id IS NOT NULL))';
      params.push(filterMember.id, filterMember.id);
    }
    const lessons = mergeGroups(db.prepare(`${sql} ORDER BY l.date, l.start_time, l.id`).all(...params));
    const members = activeMembers.all();
    const extraQuery = filterMember ? `&mitglied=${filterMember.id}` : '';
    const back = `/admin/termine?woche=${monday}${extraQuery}`;
    const defaults = {
      kind: 'individual',
      user_id: filterMember ? filterMember.id : '',
      date: monday < today && today <= D.addDays(monday, 6) ? today : monday,
      start_time: '17:00',
      duration_min: 60,
    };
    const actions = (l) => html`
      <div class="lesson-actions">
        <a href="/admin/termine/${l.id}">Uredi</a>
        <form method="post" action="/admin/termine/${l.id}/status">
          ${csrfField(req)}
          <input type="hidden" name="status" value="${l.cancelled ? 'done' : 'cancelled'}">
          <input type="hidden" name="back" value="${back}">
          <button type="submit" class="link-btn">${l.cancelled ? `Označi: ${LESSON_STATUSES.done}` : `Označi: ${LESSON_STATUSES.cancelled}`}</button>
        </form>
      </div>`;

    res.send(String(layout(req, {
      title: 'Termini',
      wide: true,
      body: html`
      <div class="page-head">
        <h1>Termini${filterMember ? ` – ${filterMember.name}` : ''}</h1>
        <form method="get" action="/admin/termine" class="inline">
          <input type="hidden" name="woche" value="${monday}">
          <select name="mitglied" aria-label="Filtriraj po članu">
            <option value="">Svi članovi</option>
            ${allMembers.all().map((m) => html`<option value="${m.id}"${filterMember && filterMember.id === m.id ? ' selected' : ''}>${m.name}</option>`)}
          </select>
          <button class="btn btn-ghost btn-sm" type="submit">Filtriraj</button>
        </form>
      </div>
      ${weekView({ monday, lessons, baseUrl: '/admin/termine', today, actions, showPrice: true, extraQuery })}
      <section class="card">
        <h2>Novi termin</h2>
        ${members.length === 0
          ? html`<p class="muted">Prvo kreiraj <a href="/admin/mitglieder/neu">člana</a>.</p>`
          : html`<form method="post" action="/admin/termine" class="form-grid">
            ${csrfField(req)}
            ${lessonFields(req, defaults, members)}
            <label>Ponavljanje
              <select name="repeat">
                <option value="1">Jednokratno</option>
                ${[4, 8, 12, 16, 26, 52].map((n) => html`<option value="${n}">Sedmično, ${n} sedmica</option>`)}
              </select>
            </label>
            <div class="span-2"><button class="btn btn-primary" type="submit">Sačuvaj termin</button></div>
          </form>`}
      </section>`,
    })));
  });

  router.post('/termine', (req, res) => {
    const { v, errors, participants } = readLessonForm(req.body);
    if (errors.length) {
      res.flash('error', errors.join(' '));
      return res.redirect(`/admin/termine${D.isValidDate(v.date) ? `?woche=${D.mondayOf(v.date)}` : ''}`);
    }
    v.cancelled = false; // novi termini su uvijek „Realizovan“
    transaction(() => {
      for (let i = 0; i < v.repeat; i++) insertOccurrence(v, participants, D.addDays(v.date, 7 * i));
    });
    const who = participantNames(participants);
    res.flash('success', v.repeat > 1
      ? `Kreirano ${v.repeat} sedmičnih termina (${LESSON_KINDS[v.kind]}) za: ${who}, od ${D.formatDateLong(v.date)}`
      : `${LESSON_KINDS[v.kind]} za: ${who} kreiran je za ${D.formatDateLong(v.date)}`);
    res.redirect(`/admin/termine?woche=${D.mondayOf(v.date)}`);
  });

  function lessonFormValues(rows) {
    const [first] = rows;
    const samePrice = rows.every((r) => r.price_cents === first.price_cents);
    const isGroup = first.kind === 'group';
    return {
      ...first,
      // Kod grupe su svi igrači označeni kvačicama, polje „Član“ ostaje prazno.
      user_id: isGroup ? '' : first.user_id,
      member_ids: isGroup ? rows.map((r) => r.user_id) : [],
      price: samePrice ? centsToInput(first.price_cents) : '',
    };
  }

  router.get('/termine/:id', (req, res) => {
    const lesson = getLesson.get(toId(req.params.id));
    if (!lesson) return notFound(res, 'termin');
    res.send(String(lessonEditPage(req, lesson, lessonFormValues(lessonSet(lesson)))));
  });

  function lessonEditPage(req, lesson, values, errors = []) {
    const members = activeMembers.all();
    // Neaktivni članovi koji su već u terminu moraju ostati izborni.
    for (const row of lessonSet(lesson)) {
      if (!members.some((m) => m.id === row.user_id)) {
        const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
        if (owner) members.unshift(owner);
      }
    }
    return layout(req, {
      title: 'Uredi termin',
      body: html`
      <div class="page-head"><h1>Uredi termin</h1>
        <a class="btn btn-ghost" href="/admin/termine?woche=${D.mondayOf(lesson.date)}">← Nazad na sedmicu</a></div>
      <section class="card">
        ${errorList(errors)}
        <form method="post" action="/admin/termine/${lesson.id}" class="form-grid">
          ${csrfField(req)}
          ${lessonFields(req, values, members, { withStatus: true })}
          <div class="span-2 btn-row"><button class="btn btn-primary" type="submit">Sačuvaj</button></div>
        </form>
      </section>
      <section class="card danger-zone">
        <form method="post" action="/admin/termine/${lesson.id}/loeschen" data-confirm="Trajno obrisati termin?">
          ${csrfField(req)}<button class="btn btn-danger" type="submit">Obriši termin</button>
        </form>
      </section>`,
    });
  }

  router.post('/termine/:id', (req, res) => {
    const lesson = getLesson.get(toId(req.params.id));
    if (!lesson) return notFound(res, 'termin');
    const { v, errors, participants } = readLessonForm(req.body);
    if (errors.length) {
      res.status(400);
      return res.send(String(lessonEditPage(req, lesson, v, errors)));
    }
    // Termin (ili cijelu grupu) zamjenjujemo novim redovima s istim group_id.
    transaction(() => {
      for (const row of lessonSet(lesson)) deleteLesson.run(row.id);
      insertOccurrence(v, participants, v.date, lesson.group_id);
    });
    res.flash('success', 'Termin je sačuvan.');
    res.redirect(`/admin/termine?woche=${D.mondayOf(v.date)}`);
  });

  router.post('/termine/:id/status', (req, res) => {
    const lesson = getLesson.get(toId(req.params.id));
    if (!lesson) return notFound(res, 'termin');
    const cancelled = req.body.status === 'cancelled' ? 1 : 0;
    const update = db.prepare('UPDATE lessons SET cancelled = ? WHERE id = ?');
    transaction(() => {
      for (const row of lessonSet(lesson)) update.run(cancelled, row.id);
    });
    res.flash('success', `Status termina: ${cancelled ? LESSON_STATUSES.cancelled : LESSON_STATUSES.done}.`);
    const back = typeof req.body.back === 'string' && req.body.back.startsWith('/admin/termine') ? req.body.back : `/admin/termine?woche=${D.mondayOf(lesson.date)}`;
    res.redirect(back);
  });

  router.post('/termine/:id/loeschen', (req, res) => {
    const lesson = getLesson.get(toId(req.params.id));
    if (!lesson) return notFound(res, 'termin');
    transaction(() => {
      for (const row of lessonSet(lesson)) deleteLesson.run(row.id);
    });
    res.flash('success', 'Termin je obrisan.');
    res.redirect(`/admin/termine?woche=${D.mondayOf(lesson.date)}`);
  });

  // ---------------------------------------------------------------- Iznosi
  function paidToggle(req, member, st, back) {
    return html`
      <form method="post" action="/admin/abrechnung/${member.id}/placeno" class="inline-form">
        ${csrfField(req)}
        <input type="hidden" name="month" value="${st.month}">
        <input type="hidden" name="paid" value="${st.paid ? '0' : '1'}">
        <input type="hidden" name="back" value="${back}">
        <button class="btn btn-sm ${st.paid ? 'btn-ghost' : 'btn-primary'}" type="submit">${st.paid ? 'Označi: nije plaćeno' : 'Označi: plaćeno'}</button>
      </form>`;
  }

  function releaseToggle(req, member, st, back) {
    return html`
      <form method="post" action="/admin/abrechnung/${member.id}/odobri" class="inline-form">
        ${csrfField(req)}
        <input type="hidden" name="month" value="${st.month}">
        <input type="hidden" name="released" value="${st.released ? '0' : '1'}">
        <input type="hidden" name="back" value="${back}">
        <button class="btn btn-sm ${st.released ? 'btn-ghost' : 'btn-primary'}" type="submit">${st.released ? 'Vrati u pripremu' : 'Odobri za člana'}</button>
      </form>`;
  }

  router.get('/abrechnung', (req, res) => {
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const rows = allMembers.all().map((m) => ({ member: m, st: monthlyStatement(db, m, month) }))
      .filter((r) => r.member.active || r.st.total !== 0);
    const sum = rows.reduce((s, r) => s + r.st.total, 0);
    const open = rows.filter((r) => !r.st.paid).reduce((s, r) => s + r.st.total, 0);
    const back = `/admin/abrechnung?monat=${month}`;

    res.send(String(layout(req, {
      title: 'Iznosi',
      wide: true,
      body: html`
      <div class="page-head"><h1>Mjesečni iznosi</h1></div>
      ${monthNav('/admin/abrechnung', month)}
      <div class="btn-row payment-row">
        <span class="muted">Odobreno za članove: ${rows.filter((r) => r.st.released).length} od ${rows.length}</span>
        <form method="post" action="/admin/abrechnung/odobri-sve" class="inline-form" data-confirm="Odobriti obračun za ${D.monthLabel(month)} svim članovima?">
          ${csrfField(req)}<input type="hidden" name="month" value="${month}"><input type="hidden" name="released" value="1">
          <button class="btn btn-primary btn-sm" type="submit">Odobri sve za ${D.monthLabel(month)}</button>
        </form>
        <form method="post" action="/admin/abrechnung/odobri-sve" class="inline-form" data-confirm="Vratiti sve obračune za ${D.monthLabel(month)} u pripremu?">
          ${csrfField(req)}<input type="hidden" name="month" value="${month}"><input type="hidden" name="released" value="0">
          <button class="btn btn-ghost btn-sm" type="submit">Sve vrati u pripremu</button>
        </form>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Član</th><th class="num">Termini</th><th class="num">Sati</th><th class="num">Članarina</th><th class="num">Treninzi</th><th class="num">Stavke</th><th class="num">Ukupno</th><th>Za člana</th><th>Plaćanje</th><th></th></tr></thead>
        <tbody>${rows.length === 0
          ? html`<tr><td colspan="10" class="empty">Nema članova.</td></tr>`
          : rows.map(({ member: m, st }) => html`<tr class="${m.active ? '' : 'is-inactive'}">
            <td><strong>${m.name}</strong>${st.mode !== 'schedule' ? html` <span class="tag">${BILLING_MODE_SHORT[st.mode]}</span>` : ''}</td>
            <td class="num">${st.manual ? '–' : st.lessonCount}</td>
            <td class="num">${formatHours(st.hours)}</td>
            <td class="num">${formatMoney(st.fee)}</td>
            <td class="num">${st.billLessons ? formatMoney(st.lessonsTotal) : '–'}</td>
            <td class="num">${formatMoney(st.adjustmentsTotal)}</td>
            <td class="num"><strong>${formatMoney(st.total)}</strong></td>
            <td>${releaseBadge(st)}</td>
            <td>${paymentBadge(st)}</td>
            <td class="actions">${releaseToggle(req, m, st, back)}${paidToggle(req, m, st, back)}<a class="btn btn-ghost btn-sm" href="/admin/abrechnung/${m.id}?monat=${month}">Detalji</a></td>
          </tr>`)}</tbody>
        <tfoot>
          <tr class="total"><td colspan="6">Ukupno ${D.monthLabel(month)}</td><td class="num">${formatMoney(sum)}</td><td colspan="3"></td></tr>
          <tr><td colspan="6">Od toga još nije plaćeno</td><td class="num">${formatMoney(open)}</td><td colspan="3"></td></tr>
        </tfoot>
      </table></div>
      <p class="muted small">Član vidi iznos za mjesec tek kad ga odobriš („Odobri za člana“); do tada vidi „Obračun u pripremi“.
        Iznosi i status plaćanja se članovima prikazuju samo informativno (tekući mjesec i ${MEMBER_MONTHS_BACK} mjeseca unazad).
        Plaćanje se ne obrađuje kroz aplikaciju.</p>`,
    })));
  });

  router.get('/abrechnung/:id', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'član');
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const st = monthlyStatement(db, member, month);
    res.send(String(layout(req, {
      title: `Iznos: ${member.name}`,
      body: html`
      <div class="page-head">
        <h1>Mjesečni iznos: ${member.name}</h1>
        <a class="btn btn-ghost" href="/admin/mitglieder/${member.id}">Uredi člana</a>
      </div>
      ${monthNav(`/admin/abrechnung/${member.id}`, month)}
      <div class="summary-tile big">
        <span class="label">Ukupno ${D.monthLabel(month)} · ${releaseBadge(st)} · ${paymentBadge(st)}</span>
        <span class="value">${formatMoney(st.total)}</span>
        <span class="hint">${formatMoney(member.hourly_rate_cents)} po satu · članarina ${formatMoney(member.monthly_fee_cents)} · ${BILLING_MODE_SHORT[st.mode]}</span>
      </div>
      <div class="btn-row payment-row">${releaseToggle(req, member, st, `/admin/abrechnung/${member.id}?monat=${month}`)}${paidToggle(req, member, st, `/admin/abrechnung/${member.id}?monat=${month}`)}</div>
      ${st.released ? '' : html`<p class="notice">Ovaj obračun je <strong>u pripremi</strong> – član umjesto iznosa vidi „Obračun u pripremi“.</p>`}
      ${st.mode === 'manual' ? html`<p class="notice">Ovaj član ima <strong>ručni obračun</strong>: treninzi iz rasporeda se ne prikazuju i ne obračunavaju.
        Iznos za mjesec unesi ispod kao stavku. Način obračuna mijenjaš kod <a href="/admin/mitglieder/${member.id}">člana</a>.</p>` : ''}
      ${st.mode === 'display' ? html`<p class="notice">Ovaj član ima <strong>raspored s prikazom, bez obračuna</strong>: termini se prikazuju,
        ali se ne naplaćuju. Iznos unesi ispod kao stavku. Način obračuna mijenjaš kod <a href="/admin/mitglieder/${member.id}">člana</a>.</p>` : ''}
      ${statementTable(st, { adminDelete: true, req })}
      <section class="card">
        <h2>Dodaj stavku</h2>
        <p class="muted small">Npr. mašina za loptice, najam terena, popust. Negativni iznosi su odobrenja.
          Cijene treninga mijenjaš direktno na <a href="/admin/termine?mitglied=${member.id}">terminu</a>.</p>
        <form method="post" action="/admin/abrechnung/${member.id}/posten" class="form-grid">
          ${csrfField(req)}
          <input type="hidden" name="month" value="${month}">
          <label>Opis *<input name="description" required maxlength="200"></label>
          <label>Iznos (${CURRENCY_SYMBOL}) *<input name="amount" required inputmode="decimal" placeholder="npr. 15,00 ili -10,00"></label>
          <div class="span-2"><button class="btn btn-primary" type="submit">Dodaj stavku</button></div>
        </form>
      </section>`,
    })));
  });

  router.post('/abrechnung/odobri-sve', (req, res) => {
    if (!D.isValidMonth(req.body.month)) return res.status(400).send('Neispravan mjesec.');
    const released = req.body.released === '1';
    const members = allMembers.all();
    db.exec('BEGIN');
    try {
      for (const m of members) setReleased(db, m.id, req.body.month, released);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.flash('success', `${D.monthLabel(req.body.month)}: ${released ? 'obračun odobren svim članovima' : 'svi obračuni vraćeni u pripremu'}.`);
    res.redirect(`/admin/abrechnung?monat=${req.body.month}`);
  });

  router.post('/abrechnung/:id/odobri', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'član');
    if (!D.isValidMonth(req.body.month)) return res.status(400).send('Neispravan mjesec.');
    const released = req.body.released === '1';
    setReleased(db, member.id, req.body.month, released);
    res.flash('success', `${member.name}, ${D.monthLabel(req.body.month)}: ${released ? 'obračun odobren za člana' : 'obračun vraćen u pripremu'}.`);
    const back = typeof req.body.back === 'string' && req.body.back.startsWith('/admin/abrechnung') ? req.body.back : '/admin/abrechnung';
    res.redirect(back);
  });

  router.post('/abrechnung/:id/placeno', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'član');
    if (!D.isValidMonth(req.body.month)) return res.status(400).send('Neispravan mjesec.');
    const paid = req.body.paid === '1';
    setPaid(db, member.id, req.body.month, paid);
    res.flash('success', `${member.name}, ${D.monthLabel(req.body.month)}: ${paid ? 'plaćeno' : 'nije plaćeno'}.`);
    const back = typeof req.body.back === 'string' && req.body.back.startsWith('/admin/abrechnung') ? req.body.back : '/admin/abrechnung';
    res.redirect(back);
  });

  router.post('/abrechnung/:id/posten', (req, res) => {
    const member = getMember.get(toId(req.params.id));
    if (!member) return notFound(res, 'član');
    const month = D.isValidMonth(req.body.month) ? req.body.month : D.monthOf(D.todayISO());
    const description = str(req.body.description, 200);
    const amount = parseMoney(req.body.amount);
    if (!description || amount === null) {
      res.flash('error', 'Molimo unesi opis i ispravan iznos.');
    } else {
      db.prepare('INSERT INTO adjustments (user_id, month, description, amount_cents) VALUES (?, ?, ?, ?)')
        .run(member.id, month, description, amount);
      res.flash('success', 'Stavka je dodana.');
    }
    res.redirect(`/admin/abrechnung/${member.id}?monat=${month}`);
  });

  router.post('/posten/:id/loeschen', (req, res) => {
    const adj = db.prepare('SELECT * FROM adjustments WHERE id = ?').get(toId(req.params.id));
    if (!adj) return notFound(res, 'stavka');
    db.prepare('DELETE FROM adjustments WHERE id = ?').run(adj.id);
    res.flash('success', 'Stavka je obrisana.');
    res.redirect(`/admin/abrechnung/${adj.user_id}?monat=${adj.month}`);
  });

  // ---------------------------------------------------------------- Aktuelnosti
  // Aktuelnosti su interni „sandučić“: admin šalje novost odabranim ili svim aktivnim članovima,
  // a članovi je vide u svom profilu (bez slanja e-maila).
  function newsPage(req, { values = {}, errors = [] } = {}) {
    const members = activeMembers.all();
    const items = db.prepare(
      `SELECT n.*, COUNT(r.user_id) AS recipients, COUNT(r.read_at) AS readers
         FROM news n LEFT JOIN news_recipients r ON r.news_id = n.id
        GROUP BY n.id ORDER BY n.created_at DESC, n.id DESC`
    ).all();
    const selected = new Set((values.member_ids || []).map(String));
    return layout(req, {
      title: 'Aktuelnosti',
      body: html`
      <div class="page-head"><div>
        <h1>Aktuelnosti</h1>
        <p class="muted">Pošalji članovima novosti – turniri, aktivnosti, obavještenja. Članovi ih vide u svom sandučiću.</p>
      </div></div>
      <section class="card">
        <h2>Nova aktuelnost</h2>
        ${errorList(errors)}
        <form method="post" action="/admin/aktuelnosti" class="stack">
          ${csrfField(req)}
          <label>Naslov *<input name="title" required maxlength="150" value="${values.title || ''}" placeholder="npr. Jesenji klupski turnir 18.10."></label>
          <label>Tekst *<textarea name="body" required rows="6" maxlength="5000">${values.body || ''}</textarea></label>
          <fieldset class="recipients">
            <legend>Primaoci</legend>
            <label class="check"><input type="radio" name="audience" value="all"${values.audience !== 'some' ? ' checked' : ''}>
              <span>Svi aktivni članovi (${members.length})</span></label>
            <label class="check"><input type="radio" name="audience" value="some"${values.audience === 'some' ? ' checked' : ''}>
              <span>Samo odabrani članovi:</span></label>
            <div class="recipient-list">
              ${members.map((m) => html`<label class="check"><input type="checkbox" name="member_ids" value="${m.id}"${selected.has(String(m.id)) ? ' checked' : ''}><span>${m.name}</span></label>`)}
            </div>
          </fieldset>
          <div><button class="btn btn-primary" type="submit">Pošalji aktuelnost</button></div>
        </form>
      </section>
      <section class="card">
        <h2>Poslane aktuelnosti</h2>
        ${items.length === 0
          ? html`<p class="muted">Još nije poslana nijedna aktuelnost.</p>`
          : html`<ul class="list">${items.map((n) => html`
            <li class="news-row">
              <div>
                <strong>${n.title}</strong> <span class="muted small">· ${D.formatDate(n.created_at.slice(0, 10))} · pročitalo ${n.readers} od ${n.recipients}</span>
                <div class="pre muted small">${n.body.length > 200 ? `${n.body.slice(0, 200)}…` : n.body}</div>
              </div>
              <form method="post" action="/admin/aktuelnosti/${n.id}/loeschen" data-confirm="Obrisati aktuelnost „${n.title}“? Nestat će i iz sandučića članova.">
                ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
              </form>
            </li>`)}</ul>`}
      </section>`,
    });
  }

  router.get('/aktuelnosti', (req, res) => {
    res.send(String(newsPage(req)));
  });

  router.post('/aktuelnosti', (req, res) => {
    const rawIds = req.body.member_ids;
    const values = {
      title: str(req.body.title, 150),
      body: str(req.body.body, 5000),
      audience: req.body.audience === 'some' ? 'some' : 'all',
      member_ids: (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map(toId).filter(Boolean),
    };
    const errors = [];
    if (!values.title) errors.push('Naslov je obavezan.');
    if (!values.body) errors.push('Tekst je obavezan.');
    const recipients = values.audience === 'all'
      ? activeMembers.all()
      : values.member_ids.map((id) => getMember.get(id)).filter(Boolean);
    if (recipients.length === 0) errors.push('Odaberi barem jednog primaoca.');
    if (errors.length) {
      res.status(400);
      return res.send(String(newsPage(req, { values, errors })));
    }
    const addRecipient = db.prepare('INSERT OR IGNORE INTO news_recipients (news_id, user_id) VALUES (?, ?)');
    db.exec('BEGIN');
    try {
      const { lastInsertRowid: newsId } = db.prepare('INSERT INTO news (title, body) VALUES (?, ?)').run(values.title, values.body);
      for (const m of recipients) addRecipient.run(newsId, m.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.flash('success', `Aktuelnost je poslana (primaoci: ${recipients.length}).`);
    res.redirect('/admin/aktuelnosti');
  });

  router.post('/aktuelnosti/:id/loeschen', (req, res) => {
    db.prepare('DELETE FROM news WHERE id = ?').run(toId(req.params.id));
    res.flash('success', 'Aktuelnost je obrisana.');
    res.redirect('/admin/aktuelnosti');
  });

  return router;
};
