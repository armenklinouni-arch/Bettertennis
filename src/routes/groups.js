'use strict';

const express = require('express');
const { html } = require('../html');
const { layout, csrfField, errorList } = require('../views');
const { requireAdmin } = require('../auth');
const { str } = require('./public');

// Stalne grupe (npr. „Grupa 1“) s članovima koji često treniraju zajedno.
// Služe kao predložak: kod kreiranja termina izborom grupe automatski se označe njeni članovi.
const GROUP_MIN = 2;
const GROUP_MAX = 8;

// „1 član“, „2 člana“, „5 članova“ (bosanska množina).
function membersLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} član`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} člana`;
  return `${n} članova`;
}

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Aktivni članovi po grupama – za izbor grupe u formularu termina.
function listGroupsWithMembers(db, { activeOnly = false } = {}) {
  const groups = db.prepare('SELECT * FROM training_groups ORDER BY name COLLATE NOCASE').all();
  const memberStmt = db.prepare(
    `SELECT u.id, u.name, u.active FROM training_group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? ${activeOnly ? 'AND u.active = 1' : ''} ORDER BY u.name COLLATE NOCASE`
  );
  return groups.map((g) => ({ ...g, members: memberStmt.all(g.id) }));
}

function groupRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const getGroup = db.prepare('SELECT * FROM training_groups WHERE id = ?');
  const activeMembers = db.prepare("SELECT * FROM users WHERE role = 'member' AND active = 1 ORDER BY name COLLATE NOCASE");
  const getMember = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member'");

  function groupForm(req, { group = null, values, errors = [] }) {
    const isNew = !group;
    const members = activeMembers.all();
    // Neaktivni članovi koji su već u grupi ostaju vidljivi.
    for (const id of values.member_ids || []) {
      if (!members.some((m) => m.id === id)) {
        const m = getMember.get(id);
        if (m) members.push(m);
      }
    }
    const selected = new Set((values.member_ids || []).map(String));
    return html`
      <form method="post" action="${isNew ? '/admin/grupe' : `/admin/grupe/${group.id}`}" class="stack">
        ${csrfField(req)}
        ${errorList(errors)}
        <label>Naziv grupe *<input name="name" required maxlength="60" value="${values.name || ''}" placeholder="npr. Grupa 1"></label>
        <fieldset class="recipients">
          <legend>Članovi grupe (${GROUP_MIN}–${GROUP_MAX})</legend>
          <div class="recipient-list">
            ${members.length === 0
              ? html`<p class="muted">Još nema aktivnih članova.</p>`
              : members.map((m) => html`<label class="check"><input type="checkbox" name="member_ids" value="${m.id}"${selected.has(String(m.id)) ? ' checked' : ''}><span>${m.name}${m.active ? '' : ' (neaktivan)'}</span></label>`)}
          </div>
        </fieldset>
        <label>Napomena<input name="notes" maxlength="300" value="${values.notes || ''}" placeholder="npr. srijedom 18 h, napredni"></label>
        <div class="btn-row">
          <button class="btn btn-primary" type="submit">${isNew ? 'Kreiraj grupu' : 'Sačuvaj grupu'}</button>
          ${isNew ? '' : html`<a class="btn btn-ghost" href="/admin/grupe">Odustani</a>`}
        </div>
      </form>`;
  }

  function page(req, { formHtml, editing = null }) {
    const groups = listGroupsWithMembers(db);
    return layout(req, {
      title: 'Grupe',
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>Grupe</h1>
        <p class="muted">Stalne grupe igrača koji često treniraju zajedno. Kod kreiranja termina odabereš grupu i njeni članovi se automatski označe.</p>
      </div></div>
      <div class="two-col">
        <section class="card">
          <h2>${editing ? `Uredi: ${editing.name}` : 'Nova grupa'}</h2>
          ${formHtml}
        </section>
        <section class="card">
          <h2>Postojeće grupe (${groups.length})</h2>
          ${groups.length === 0
            ? html`<p class="muted">Još nema grupa.</p>`
            : html`<ul class="list">${groups.map((g) => html`
              <li class="news-row">
                <div>
                  <strong>${g.name}</strong> <span class="tag">${membersLabel(g.members.length)}</span>
                  <div class="small">${g.members.map((m) => m.name).join(', ') || '–'}</div>
                  ${g.notes ? html`<div class="small muted">${g.notes}</div>` : ''}
                </div>
                <div class="btn-row">
                  <a class="btn btn-ghost btn-sm" href="/admin/grupe/${g.id}">Uredi</a>
                  <form method="post" action="/admin/grupe/${g.id}/loeschen" data-confirm="Obrisati grupu ${g.name}? Postojeći termini ostaju.">
                    ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
                  </form>
                </div>
              </li>`)}</ul>`}
        </section>
      </div>`,
    });
  }

  function readForm(body) {
    const raw = Array.isArray(body.member_ids) ? body.member_ids : body.member_ids ? [body.member_ids] : [];
    const values = {
      name: str(body.name, 60),
      notes: str(body.notes, 300),
      member_ids: [...new Set(raw.map(toId).filter(Boolean))].filter((id) => getMember.get(id)),
    };
    const errors = [];
    if (!values.name) errors.push('Naziv grupe je obavezan.');
    if (values.member_ids.length < GROUP_MIN) errors.push(`Grupa mora imati najmanje ${GROUP_MIN} člana.`);
    if (values.member_ids.length > GROUP_MAX) errors.push(`Grupa može imati najviše ${GROUP_MAX} članova.`);
    return { values, errors };
  }

  function nameTaken(name, exceptId = 0) {
    return !!db.prepare('SELECT id FROM training_groups WHERE name = ? COLLATE NOCASE AND id != ?').get(name, exceptId);
  }

  function saveMembers(groupId, memberIds) {
    db.prepare('DELETE FROM training_group_members WHERE group_id = ?').run(groupId);
    const insert = db.prepare('INSERT INTO training_group_members (group_id, user_id) VALUES (?, ?)');
    for (const id of memberIds) insert.run(groupId, id);
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
    const nextNumber = db.prepare('SELECT COUNT(*) AS n FROM training_groups').get().n + 1;
    res.send(String(page(req, { formHtml: groupForm(req, { values: { name: `Grupa ${nextNumber}` } }) })));
  });

  router.post('/', (req, res) => {
    const { values, errors } = readForm(req.body);
    if (!errors.length && nameTaken(values.name)) errors.push('Grupa s tim nazivom već postoji.');
    if (errors.length) {
      res.status(400);
      return res.send(String(page(req, { formHtml: groupForm(req, { values, errors }) })));
    }
    transaction(() => {
      const { lastInsertRowid } = db.prepare('INSERT INTO training_groups (name, notes) VALUES (?, ?)').run(values.name, values.notes || null);
      saveMembers(lastInsertRowid, values.member_ids);
    });
    res.flash('success', `Grupa „${values.name}“ je kreirana (${membersLabel(values.member_ids.length)}).`);
    res.redirect('/admin/grupe');
  });

  router.get('/:id', (req, res) => {
    const group = getGroup.get(toId(req.params.id));
    if (!group) return res.status(404).send('Nije pronađeno: grupa.');
    const memberIds = db.prepare('SELECT user_id FROM training_group_members WHERE group_id = ?').all(group.id).map((r) => r.user_id);
    const values = { name: group.name, notes: group.notes || '', member_ids: memberIds };
    res.send(String(page(req, { editing: group, formHtml: groupForm(req, { group, values }) })));
  });

  router.post('/:id', (req, res) => {
    const group = getGroup.get(toId(req.params.id));
    if (!group) return res.status(404).send('Nije pronađeno: grupa.');
    const { values, errors } = readForm(req.body);
    if (!errors.length && nameTaken(values.name, group.id)) errors.push('Grupa s tim nazivom već postoji.');
    if (errors.length) {
      res.status(400);
      return res.send(String(page(req, { editing: group, formHtml: groupForm(req, { group, values, errors }) })));
    }
    transaction(() => {
      db.prepare('UPDATE training_groups SET name = ?, notes = ? WHERE id = ?').run(values.name, values.notes || null, group.id);
      saveMembers(group.id, values.member_ids);
    });
    res.flash('success', `Grupa „${values.name}“ je sačuvana.`);
    res.redirect('/admin/grupe');
  });

  router.post('/:id/loeschen', (req, res) => {
    const group = getGroup.get(toId(req.params.id));
    if (!group) return res.status(404).send('Nije pronađeno: grupa.');
    db.prepare('DELETE FROM training_groups WHERE id = ?').run(group.id);
    res.flash('success', `Grupa „${group.name}“ je obrisana.`);
    res.redirect('/admin/grupe');
  });

  return router;
}

module.exports = groupRoutes;
module.exports.listGroupsWithMembers = listGroupsWithMembers;
