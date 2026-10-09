'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney, centsToInput, parseMoney, CURRENCY_SYMBOL } = require('../money');
const { formatHours } = require('../billing');
const { trainerReport } = require('../trainers');
const { layout, csrfField, errorList, monthNav, lessonTimeRange, LESSON_KINDS } = require('../views');
const { requireAdmin, hashPassword } = require('../auth');
const { EMAIL_RE, str } = require('./public');

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = function trainerRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const getTrainer = db.prepare('SELECT * FROM trainers WHERE id = ?');
  const allTrainers = db.prepare('SELECT * FROM trainers ORDER BY active DESC, name COLLATE NOCASE');

  function notFound(res) {
    res.status(404);
    return res.send('Nije pronađeno: trener.');
  }

  function currentMonth(query) {
    return D.isValidMonth(query.monat) ? query.monat : D.monthOf(D.todayISO());
  }

  // ---------------------------------------------------------------- Izvještaj svih trenera
  router.get('/', (req, res) => {
    const month = currentMonth(req.query);
    const rows = allTrainers.all().map((t) => ({ trainer: t, r: trainerReport(db, t, month) }))
      .filter(({ trainer, r }) => trainer.active || r.sessions.length || r.bonuses.length);
    const sum = (fn) => rows.reduce((s, row) => s + fn(row.r), 0);
    const { first, last } = D.monthRange(month);
    const unassigned = db.prepare(
      `SELECT COUNT(DISTINCT COALESCE(group_id, 'L' || id)) AS n FROM lessons
        WHERE trainer_id IS NULL AND cancelled = 0 AND date BETWEEN ? AND ?`
    ).get(first, last).n;

    res.send(String(layout(req, {
      title: 'Treneri',
      wide: true,
      body: html`
      <div class="page-head">
        <div>
          <h1>Treneri – izvještaj</h1>
          <p class="muted">Realizovani treninzi po treneru i isplata za ${D.monthLabel(month)}. Grupni trening se broji jednom po terminu.</p>
        </div>
        <a class="btn btn-primary" href="/admin/treneri/neu">+ Novi trener</a>
      </div>
      ${monthNav('/admin/treneri', month)}
      ${unassigned ? html`<p class="notice">U ovom mjesecu ima <strong>${unassigned}</strong> realizovanih termina bez trenera.
        Trenera biraš kod <a href="/admin/termine">termina</a>.</p>` : ''}
      ${rows.length === 0
        ? html`<p class="card muted">Još nema trenera. <a href="/admin/treneri/neu">Kreiraj prvog trenera.</a></p>`
        : html`<div class="table-wrap"><table class="report">
          <thead>
            <tr><th rowspan="2">Trener</th><th colspan="3" class="group-head">Individualni treninzi</th><th colspan="3" class="group-head">Grupni treninzi</th>
              <th rowspan="2" class="num">Dodatno</th><th rowspan="2" class="num">Isplata ukupno</th><th rowspan="2" class="num">Vrijednost treninga</th><th rowspan="2" class="num">Razlika</th><th rowspan="2"></th></tr>
            <tr><th class="num">Broj</th><th class="num">Sati</th><th class="num">Isplata</th><th class="num">Broj</th><th class="num">Sati</th><th class="num">Isplata</th></tr>
          </thead>
          <tbody>${rows.map(({ trainer: t, r }) => html`
            <tr class="${t.active ? '' : 'is-inactive'}">
              <td><strong>${t.name}</strong><br><span class="small muted">${formatMoney(t.rate_individual_cents)}/h indiv. · ${formatMoney(t.rate_group_cents)}/h grupa</span></td>
              <td class="num">${r.individual.count}</td>
              <td class="num">${formatHours(r.individual.minutes / 60)}</td>
              <td class="num">${formatMoney(r.individual.pay)}</td>
              <td class="num">${r.group.count}</td>
              <td class="num">${formatHours(r.group.minutes / 60)}</td>
              <td class="num">${formatMoney(r.group.pay)}</td>
              <td class="num">${formatMoney(r.bonusTotal)}</td>
              <td class="num"><strong>${formatMoney(r.payTotal)}</strong></td>
              <td class="num">${formatMoney(r.valueTotal)}</td>
              <td class="num ${r.margin < 0 ? 'negative' : ''}">${formatMoney(r.margin)}</td>
              <td class="actions">
                <a class="btn btn-ghost btn-sm" href="/admin/treneri/${t.id}?monat=${month}">Detalji</a>
                <a class="btn btn-ghost btn-sm" href="/admin/treneri/${t.id}/uredi">Uredi</a>
              </td>
            </tr>`)}</tbody>
          <tfoot><tr class="total">
            <td>Ukupno</td>
            <td class="num">${sum((r) => r.individual.count)}</td>
            <td class="num">${formatHours(sum((r) => r.individual.minutes) / 60)}</td>
            <td class="num">${formatMoney(sum((r) => r.individual.pay))}</td>
            <td class="num">${sum((r) => r.group.count)}</td>
            <td class="num">${formatHours(sum((r) => r.group.minutes) / 60)}</td>
            <td class="num">${formatMoney(sum((r) => r.group.pay))}</td>
            <td class="num">${formatMoney(sum((r) => r.bonusTotal))}</td>
            <td class="num">${formatMoney(sum((r) => r.payTotal))}</td>
            <td class="num">${formatMoney(sum((r) => r.valueTotal))}</td>
            <td class="num">${formatMoney(sum((r) => r.margin))}</td>
            <td></td>
          </tr></tfoot>
        </table></div>`}
      <p class="muted small">„Vrijednost treninga“ je zbir cijena članova za te termine. „Razlika“ = vrijednost treninga − isplata treneru (uklj. dodatno).</p>`,
    })));
  });

  // ---------------------------------------------------------------- Kreiranje / uređivanje
  function trainerForm(req, { trainer = null, values, errors = [] }) {
    const isNew = !trainer;
    const v = values;
    return layout(req, {
      title: isNew ? 'Novi trener' : `Trener: ${trainer.name}`,
      body: html`
      <div class="page-head">
        <h1>${isNew ? 'Novi trener' : `Uredi trenera: ${trainer.name}`}</h1>
        ${isNew ? '' : html`<a class="btn btn-ghost" href="/admin/treneri/${trainer.id}">Izvještaj</a>`}
      </div>
      <section class="card">
        ${errorList(errors)}
        <form method="post" action="${isNew ? '/admin/treneri' : `/admin/treneri/${trainer.id}`}" class="form-grid">
          ${csrfField(req)}
          <label>Ime i prezime *<input name="name" required maxlength="120" value="${v.name || ''}"></label>
          <label>Telefon<input name="phone" type="tel" maxlength="50" value="${v.phone || ''}"></label>
          <label class="span-2">E-mail (za prijavu trenera)<input name="email" type="email" maxlength="200" value="${v.email || ''}"></label>
          <label class="span-2">${isNew || !trainer.password_hash
            ? 'Lozinka za prijavu (najmanje 8 znakova; prazno = trener nema pristup)'
            : 'Nova lozinka za prijavu (prazno = bez promjene)'}
            <input name="password" type="text" autocomplete="new-password" minlength="8" value="${v.password || ''}">
          </label>
          ${!isNew && trainer.password_hash
            ? html`<label class="check span-2"><input type="checkbox" name="revoke" value="1"><span>Ukloni pristup (trener se više ne može prijaviti)</span></label>`
            : ''}
          <p class="muted small span-2">Prijavljeni trener vidi samo svoje termine, svoje igrače, svoje sate i svoju isplatu – ne vidi druge trenere ni cijene članova.</p>
          <label>Isplata – individualni trening (${CURRENCY_SYMBOL} po satu)
            <input name="rate_individual" inputmode="decimal" placeholder="npr. 25,00" value="${v.rate_individual || ''}"></label>
          <label>Isplata – grupni trening (${CURRENCY_SYMBOL} po satu)
            <input name="rate_group" inputmode="decimal" placeholder="npr. 35,00" value="${v.rate_group || ''}"></label>
          <label class="span-2">Bilješke<textarea name="notes" rows="3" maxlength="2000">${v.notes || ''}</textarea></label>
          <label class="check span-2"><input type="checkbox" name="active" value="1"${v.active ? ' checked' : ''}><span>Aktivan (može se birati kod termina)</span></label>
          <div class="span-2 btn-row"><button class="btn btn-primary" type="submit">Sačuvaj</button>
            <a class="btn btn-ghost" href="/admin/treneri">Odustani</a></div>
        </form>
      </section>
      ${isNew ? '' : html`
      <section class="card danger-zone">
        <h2>Brisanje trenera</h2>
        <p class="muted">Termini ostaju sačuvani, ali bez trenera. Dodatne isplate se brišu. Umjesto toga trenera možeš označiti kao neaktivnog.</p>
        <form method="post" action="/admin/treneri/${trainer.id}/loeschen" data-confirm="Trajno obrisati trenera ${trainer.name}?">
          ${csrfField(req)}<button class="btn btn-danger" type="submit">Trajno obriši</button>
        </form>
      </section>`}`,
    });
  }

  // E-mail za prijavu mora biti jedinstven među članovima, adminima i trenerima.
  function emailTaken(email, exceptTrainerId = 0) {
    if (!email) return false;
    return !!db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)
      || !!db.prepare('SELECT id FROM trainers WHERE email = ? COLLATE NOCASE AND id != ?').get(email, exceptTrainerId);
  }

  function readTrainerForm(body) {
    const values = {
      name: str(body.name, 120),
      phone: str(body.phone, 50),
      email: str(body.email, 200),
      rate_individual: str(body.rate_individual, 20),
      rate_group: str(body.rate_group, 20),
      notes: str(body.notes, 2000),
      active: body.active === '1',
      password: typeof body.password === 'string' ? body.password : '',
      revoke: body.revoke === '1',
    };
    const errors = [];
    if (!values.name) errors.push('Ime trenera je obavezno.');
    if (values.email && !EMAIL_RE.test(values.email)) errors.push('Neispravna e-mail adresa.');
    if (values.password && values.password.length < 8) errors.push('Lozinka mora imati najmanje 8 znakova.');
    if (values.password && !values.email) errors.push('Za prijavu trenera potreban je e-mail.');
    const rateIndividual = values.rate_individual === '' ? 0 : parseMoney(values.rate_individual);
    const rateGroup = values.rate_group === '' ? 0 : parseMoney(values.rate_group);
    if (rateIndividual === null || rateIndividual < 0) errors.push('Neispravna isplata za individualni trening.');
    if (rateGroup === null || rateGroup < 0) errors.push('Neispravna isplata za grupni trening.');
    return { values, errors, rateIndividual, rateGroup };
  }

  router.get('/neu', (req, res) => {
    res.send(String(trainerForm(req, { values: { active: true } })));
  });

  router.post('/', (req, res) => {
    const { values, errors, rateIndividual, rateGroup } = readTrainerForm(req.body);
    if (!errors.length && emailTaken(values.email)) errors.push('Ova e-mail adresa se već koristi.');
    if (errors.length) {
      res.status(400);
      return res.send(String(trainerForm(req, { values, errors })));
    }
    const r = db.prepare(
      `INSERT INTO trainers (name, phone, email, rate_individual_cents, rate_group_cents, active, notes, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(values.name, values.phone || null, values.email || null, rateIndividual, rateGroup, values.active ? 1 : 0, values.notes || null,
      values.password ? hashPassword(values.password) : null);
    res.flash('success', `Trener ${values.name} je kreiran.${values.password ? ` Prijava: ${values.email} / lozinka: ${values.password}` : ''}`);
    res.redirect(`/admin/treneri/${r.lastInsertRowid}`);
  });

  router.get('/:id/uredi', (req, res) => {
    const trainer = getTrainer.get(toId(req.params.id));
    if (!trainer) return notFound(res);
    res.send(String(trainerForm(req, {
      trainer,
      values: {
        ...trainer,
        password: '',
        rate_individual: centsToInput(trainer.rate_individual_cents),
        rate_group: centsToInput(trainer.rate_group_cents),
        active: !!trainer.active,
      },
    })));
  });

  router.post('/:id', (req, res) => {
    const trainer = getTrainer.get(toId(req.params.id));
    if (!trainer) return notFound(res);
    const { values, errors, rateIndividual, rateGroup } = readTrainerForm(req.body);
    if (!errors.length && emailTaken(values.email, trainer.id)) errors.push('Ova e-mail adresa se već koristi.');
    if (!errors.length && trainer.password_hash && !values.revoke && !values.email) errors.push('Trener ima pristup – e-mail ne može biti prazan.');
    if (errors.length) {
      res.status(400);
      return res.send(String(trainerForm(req, { trainer, values, errors })));
    }
    db.prepare(
      `UPDATE trainers SET name = ?, phone = ?, email = ?, rate_individual_cents = ?, rate_group_cents = ?, active = ?, notes = ?
        WHERE id = ?`
    ).run(values.name, values.phone || null, values.email || null, rateIndividual, rateGroup, values.active ? 1 : 0, values.notes || null, trainer.id);
    let access = '';
    if (values.revoke) {
      db.prepare('UPDATE trainers SET password_hash = NULL WHERE id = ?').run(trainer.id);
      access = ' Pristup je uklonjen.';
    } else if (values.password) {
      db.prepare('UPDATE trainers SET password_hash = ? WHERE id = ?').run(hashPassword(values.password), trainer.id);
      access = ` Prijava: ${values.email} / lozinka: ${values.password}`;
    }
    res.flash('success', `Promjene za trenera ${values.name} su sačuvane.${access}`);
    res.redirect(`/admin/treneri/${trainer.id}`);
  });

  router.post('/:id/loeschen', (req, res) => {
    const trainer = getTrainer.get(toId(req.params.id));
    if (!trainer) return notFound(res);
    db.prepare('DELETE FROM trainers WHERE id = ?').run(trainer.id);
    res.flash('success', `Trener ${trainer.name} je obrisan.`);
    res.redirect('/admin/treneri');
  });

  // ---------------------------------------------------------------- Izvještaj jednog trenera
  router.get('/:id', (req, res) => {
    const trainer = getTrainer.get(toId(req.params.id));
    if (!trainer) return notFound(res);
    const month = currentMonth(req.query);
    const r = trainerReport(db, trainer, month);

    res.send(String(layout(req, {
      title: `Trener: ${trainer.name}`,
      wide: true,
      body: html`
      <div class="page-head">
        <div>
          <h1>${trainer.name}</h1>
          <p class="muted">Isplata: ${formatMoney(trainer.rate_individual_cents)}/h individualni · ${formatMoney(trainer.rate_group_cents)}/h grupni trening
            ${trainer.active ? '' : html` · <span class="tag">neaktivan</span>`}
            · ${trainer.password_hash && trainer.email ? html`<span class="tag tag-done">Pristup: ${trainer.email}</span>` : html`<span class="tag">bez pristupa</span>`}</p>
        </div>
        <div class="btn-row">
          <a class="btn btn-ghost" href="/admin/treneri/${trainer.id}/uredi">Uredi trenera</a>
          <a class="btn btn-ghost" href="/admin/treneri?monat=${month}">← Svi treneri</a>
        </div>
      </div>
      ${monthNav(`/admin/treneri/${trainer.id}`, month)}
      <div class="tiles">
        <div class="summary-tile"><span class="label">Individualni treninzi</span><span class="value">${r.individual.count}</span>
          <span class="hint">${formatHours(r.individual.minutes / 60)} · isplata ${formatMoney(r.individual.pay)}</span></div>
        <div class="summary-tile"><span class="label">Grupni treninzi</span><span class="value">${r.group.count}</span>
          <span class="hint">${formatHours(r.group.minutes / 60)} · isplata ${formatMoney(r.group.pay)}</span></div>
        <div class="summary-tile"><span class="label">Dodatno (bonusi i sl.)</span><span class="value">${formatMoney(r.bonusTotal)}</span>
          <span class="hint">Stavki: ${r.bonuses.length}</span></div>
        <div class="summary-tile"><span class="label">Isplata ukupno ${D.monthLabel(month)}</span><span class="value">${formatMoney(r.payTotal)}</span>
          <span class="hint">Razlika (vrijednost − isplata): ${formatMoney(r.margin)}</span></div>
      </div>

      <section class="card">
        <h2>Odrađeni treninzi (${r.sessions.length})</h2>
        ${r.sessions.length === 0
          ? html`<p class="muted">U ovom mjesecu trener nema realizovanih treninga.</p>`
          : html`<div class="table-wrap"><table>
            <thead><tr><th>Datum</th><th>Vrijeme</th><th>Vrsta</th><th>Članovi</th><th class="num">Trajanje</th><th class="num">Vrijednost</th><th class="num">Isplata treneru</th><th></th></tr></thead>
            <tbody>${r.sessions.map((s) => html`
              <tr>
                <td>${D.formatDateLong(s.date)}</td>
                <td>${lessonTimeRange(s)} h${s.court ? ` · Teren ${s.court}` : ''}</td>
                <td><span class="tag tag-kind${s.kind === 'group' ? ' is-group' : ''}">${LESSON_KINDS[s.kind]}</span></td>
                <td>${s.members.join(', ')}</td>
                <td class="num">${s.duration_min} min</td>
                <td class="num">${formatMoney(s.value_cents)}</td>
                <td class="num">${formatMoney(s.pay_cents)}</td>
                <td class="actions"><a class="btn btn-ghost btn-sm" href="/admin/termine/${s.id}">Termin</a></td>
              </tr>`)}</tbody>
            <tfoot><tr class="total"><td colspan="5">Ukupno treninzi</td><td class="num">${formatMoney(r.valueTotal)}</td>
              <td class="num">${formatMoney(r.individual.pay + r.group.pay)}</td><td></td></tr></tfoot>
          </table></div>`}
        <p class="muted small">Računaju se samo termini sa statusom „Realizovan“. Otkazani termini se ne isplaćuju.</p>
      </section>

      <section class="card">
        <h2>Dodatne isplate</h2>
        <p class="muted small">Npr. nagrada, bonus za turnir, putni troškovi. Negativan iznos je odbitak.</p>
        ${r.bonuses.length === 0
          ? html`<p class="muted">Nema dodatnih isplata za ${D.monthLabel(month)}.</p>`
          : html`<ul class="list">${r.bonuses.map((b) => html`
            <li class="news-row">
              <div><strong>${b.description}</strong> · ${formatMoney(b.amount_cents)}</div>
              <form method="post" action="/admin/treneri/dodatno/${b.id}/loeschen" data-confirm="Obrisati dodatnu isplatu?">
                ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
              </form>
            </li>`)}</ul>`}
        <form method="post" action="/admin/treneri/${trainer.id}/dodatno" class="form-grid">
          ${csrfField(req)}
          <input type="hidden" name="month" value="${month}">
          <label>Opis *<input name="description" required maxlength="200" placeholder="npr. Nagrada za klupski turnir"></label>
          <label>Iznos (${CURRENCY_SYMBOL}) *<input name="amount" required inputmode="decimal" placeholder="npr. 50,00"></label>
          <div class="span-2"><button class="btn btn-primary" type="submit">Dodaj isplatu</button></div>
        </form>
      </section>`,
    })));
  });

  router.post('/:id/dodatno', (req, res) => {
    const trainer = getTrainer.get(toId(req.params.id));
    if (!trainer) return notFound(res);
    const month = D.isValidMonth(req.body.month) ? req.body.month : D.monthOf(D.todayISO());
    const description = str(req.body.description, 200);
    const amount = parseMoney(req.body.amount);
    if (!description || amount === null) {
      res.flash('error', 'Molimo unesi opis i ispravan iznos.');
    } else {
      db.prepare('INSERT INTO trainer_bonuses (trainer_id, month, description, amount_cents) VALUES (?, ?, ?, ?)')
        .run(trainer.id, month, description, amount);
      res.flash('success', 'Dodatna isplata je dodana.');
    }
    res.redirect(`/admin/treneri/${trainer.id}?monat=${month}`);
  });

  router.post('/dodatno/:id/loeschen', (req, res) => {
    const bonus = db.prepare('SELECT * FROM trainer_bonuses WHERE id = ?').get(toId(req.params.id));
    if (!bonus) return res.status(404).send('Nije pronađeno: isplata.');
    db.prepare('DELETE FROM trainer_bonuses WHERE id = ?').run(bonus.id);
    res.flash('success', 'Dodatna isplata je obrisana.');
    res.redirect(`/admin/treneri/${bonus.trainer_id}?monat=${bonus.month}`);
  });

  return router;
};
