'use strict';

// Admin: roditeljski računi (Elternkonten) – kreiranje, uređivanje, dodjela igrača, brisanje.
const express = require('express');
const { html } = require('../html');
const { layout, csrfField, errorList } = require('../views');
const { requireAdmin, hashPassword, readablePassword } = require('../auth');
const { USERNAME_RE, normalizeUsername, usernameTaken } = require('../db');
const { str } = require('./public');

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = function parentAccountRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const getAccount = db.prepare('SELECT * FROM parent_accounts WHERE id = ?');
  const allMembers = db.prepare("SELECT * FROM users WHERE role = 'member' ORDER BY active DESC, name COLLATE NOCASE");
  const playersOf = db.prepare(
    `SELECT u.* FROM parent_account_players p JOIN users u ON u.id = p.user_id
      WHERE p.parent_account_id = ? ORDER BY u.name COLLATE NOCASE`
  );

  function setPlayers(accountId, ids) {
    db.prepare('DELETE FROM parent_account_players WHERE parent_account_id = ?').run(accountId);
    const add = db.prepare('INSERT INTO parent_account_players (parent_account_id, user_id) VALUES (?, ?)');
    for (const id of ids) add.run(accountId, id);
  }

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  router.get('/', (req, res) => {
    const accounts = db.prepare('SELECT * FROM parent_accounts ORDER BY active DESC, name COLLATE NOCASE').all();
    res.send(String(layout(req, {
      title: 'Roditelji',
      wide: true,
      body: html`
      <div class="page-head">
        <h1>Roditeljski računi</h1>
        <a class="btn btn-primary" href="/admin/roditelji/novi">+ Novi roditeljski račun</a>
      </div>
      <p class="muted">Roditeljski račun vidi (samo čitanje) zajednički sedmični raspored i mjesečne iznose dodijeljenih igrača.
        Igrači ostaju obični članovi sa svojim terminima i obračunom.</p>
      ${accounts.length === 0
        ? html`<p class="card muted">Još nema roditeljskih računa.</p>`
        : html`<div class="table-wrap"><table>
          <thead><tr><th>Ime</th><th>Korisničko ime</th><th>Igrači</th><th>Status</th><th></th></tr></thead>
          <tbody>${accounts.map((a) => html`<tr class="${a.active ? '' : 'is-inactive'}">
            <td><strong>${a.name}</strong></td>
            <td><code>${a.username}</code></td>
            <td>${playersOf.all(a.id).map((p) => p.name).join(', ') || '–'}</td>
            <td>${a.active ? 'aktivan' : 'neaktivan'}</td>
            <td class="actions"><a class="btn btn-ghost btn-sm" href="/admin/roditelji/${a.id}">Uredi</a></td>
          </tr>`)}</tbody></table></div>`}`,
    })));
  });

  function accountForm(req, { account = null, values, errors = [] }) {
    const isNew = !account;
    const selected = new Set((values.player_ids || []).map(Number));
    const members = allMembers.all();
    return layout(req, {
      title: isNew ? 'Novi roditeljski račun' : `Roditelj: ${account.name}`,
      body: html`
      <div class="page-head">
        <h1>${isNew ? 'Novi roditeljski račun' : `Uredi roditeljski račun: ${account.name}`}</h1>
        <a class="btn btn-ghost" href="/admin/roditelji">← Svi roditeljski računi</a>
      </div>
      <section class="card">
        ${errorList(errors)}
        <form method="post" action="${isNew ? '/admin/roditelji' : `/admin/roditelji/${account.id}`}" class="form-grid">
          ${csrfField(req)}
          <label>Ime i prezime *<input name="name" required maxlength="120" value="${values.name || ''}"></label>
          <label>Korisničko ime (za prijavu) *<input name="username" required minlength="3" maxlength="40" autocapitalize="none" spellcheck="false" value="${values.username || ''}">
            <span class="small muted">3–40 znakova: slova bez kvačica, brojevi, tačka, crtica, donja crta.</span></label>
          <label class="span-2">${isNew ? 'Lozinka * (najmanje 8 znakova)' : 'Nova lozinka (ostavi prazno = bez promjene)'}
            <input name="password" type="text" autocomplete="new-password" minlength="8" ${isNew ? 'required' : ''} value="${values.password || ''}">
          </label>
          <fieldset class="span-2 group-members">
            <legend>Igrači (najmanje jedan) *</legend>
            ${members.length === 0
              ? html`<p class="muted">Još nema članova.</p>`
              : members.map((m) => html`<label class="check"><input type="checkbox" name="player_ids" value="${m.id}"${selected.has(m.id) ? ' checked' : ''}>
                  <span>${m.name}${m.username ? html` <span class="muted small">(${m.username})</span>` : ''}${m.active ? '' : html` <span class="tag">neaktivan</span>`}</span></label>`)}
          </fieldset>
          <label class="check span-2"><input type="checkbox" name="active" value="1"${values.active ? ' checked' : ''}><span>Aktivan (smije se prijaviti)</span></label>
          <div class="span-2 btn-row"><button class="btn btn-primary" type="submit">Sačuvaj</button>
            <a class="btn btn-ghost" href="/admin/roditelji">Odustani</a></div>
        </form>
      </section>
      ${isNew ? '' : html`
      <section class="card danger-zone">
        <h2>Brisanje roditeljskog računa</h2>
        <p class="muted">Briše se samo roditeljski račun. Igrači (članovi) i njihovi podaci ostaju netaknuti.</p>
        <form method="post" action="/admin/roditelji/${account.id}/obrisi" data-confirm="Trajno obrisati roditeljski račun ${account.name}?">
          ${csrfField(req)}<button class="btn btn-danger" type="submit">Trajno obriši</button>
        </form>
      </section>`}`,
    });
  }

  function readForm(body, account) {
    const memberIds = new Set(allMembers.all().map((m) => m.id));
    const values = {
      name: str(body.name, 120),
      username: normalizeUsername(str(body.username, 200)),
      password: typeof body.password === 'string' ? body.password : '',
      player_ids: [...new Set([].concat(body.player_ids || []).map(Number))].filter((id) => memberIds.has(id)),
      active: body.active === '1',
    };
    const errors = [];
    if (!values.name) errors.push('Nedostaje ime.');
    if (!USERNAME_RE.test(values.username)) errors.push('Neispravno korisničko ime (3–40 znakova: a–z, 0–9, tačka, crtica, donja crta).');
    else if (usernameTaken(db, values.username, { parentAccountId: account ? account.id : 0 })) errors.push('Ovo korisničko ime je već zauzeto.');
    if ((!account || values.password) && values.password.length < 8) errors.push('Lozinka mora imati najmanje 8 znakova.');
    if (values.player_ids.length === 0) errors.push('Odaberi barem jednog igrača.');
    return { values, errors };
  }

  router.get('/novi', (req, res) => {
    res.send(String(accountForm(req, { values: { active: true, password: readablePassword(), player_ids: [] } })));
  });

  router.post('/', (req, res) => {
    const { values, errors } = readForm(req.body, null);
    if (errors.length) {
      res.status(400);
      return res.send(String(accountForm(req, { values, errors })));
    }
    const id = transaction(() => {
      const r = db.prepare('INSERT INTO parent_accounts (name, username, password_hash, active) VALUES (?, ?, ?, ?)')
        .run(values.name, values.username, hashPassword(values.password), values.active ? 1 : 0);
      setPlayers(r.lastInsertRowid, values.player_ids);
      return r.lastInsertRowid;
    });
    res.flash('success', `Roditeljski račun ${values.name} je kreiran. Prijava: ${values.username} / lozinka: ${values.password}`);
    res.redirect(`/admin/roditelji/${id}`);
  });

  router.get('/:id', (req, res) => {
    const account = getAccount.get(toId(req.params.id));
    if (!account) return res.status(404).send('Nije pronađeno: roditeljski račun.');
    const values = { ...account, password: '', active: !!account.active, player_ids: playersOf.all(account.id).map((p) => p.id) };
    res.send(String(accountForm(req, { account, values })));
  });

  router.post('/:id', (req, res) => {
    const account = getAccount.get(toId(req.params.id));
    if (!account) return res.status(404).send('Nije pronađeno: roditeljski račun.');
    const { values, errors } = readForm(req.body, account);
    if (errors.length) {
      res.status(400);
      return res.send(String(accountForm(req, { account, values, errors })));
    }
    transaction(() => {
      db.prepare('UPDATE parent_accounts SET name = ?, username = ?, active = ? WHERE id = ?')
        .run(values.name, values.username, values.active ? 1 : 0, account.id);
      if (values.password) db.prepare('UPDATE parent_accounts SET password_hash = ? WHERE id = ?').run(hashPassword(values.password), account.id);
      setPlayers(account.id, values.player_ids);
    });
    res.flash('success', `Promjene za ${values.name} su sačuvane.${values.password ? ` Nova lozinka: ${values.password}` : ''}`);
    res.redirect(`/admin/roditelji/${account.id}`);
  });

  router.post('/:id/obrisi', (req, res) => {
    const account = getAccount.get(toId(req.params.id));
    if (!account) return res.status(404).send('Nije pronađeno: roditeljski račun.');
    db.prepare('DELETE FROM parent_accounts WHERE id = ?').run(account.id);
    res.flash('success', `Roditeljski račun ${account.name} je obrisan.`);
    res.redirect('/admin/roditelji');
  });

  return router;
};
