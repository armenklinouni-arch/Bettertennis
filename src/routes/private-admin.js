'use strict';

// Admin: privatni časovi – slobodni termini (dodaj, blokiraj/odblokiraj, obriši) i upiti članova
// (otvoreni / završeni). Upit nikad ne blokira termin i ne pravi automatski trening u rasporedu.
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { layout, csrfField, errorList } = require('../views');
const { requireAdmin } = require('../auth');
const { isSlotOpen, slotStartMs, slotLabel, formatSarajevo } = require('../private-lessons');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = function privateAdminRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const getSlot = db.prepare('SELECT * FROM private_slots WHERE id = ?');
  const allSlots = db.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM private_requests r WHERE r.slot_id = s.id) AS requests
       FROM private_slots s ORDER BY s.date, s.start_time, s.id`
  );
  const requestsWhere = (done) => db.prepare(
    `SELECT r.*, u.name AS member_name, u.username, u.email, u.phone FROM private_requests r
       JOIN users u ON u.id = r.user_id WHERE r.done = ${done ? 1 : 0}
      ORDER BY ${done ? 'r.done_at DESC' : 'r.requested_at'}, r.id`
  ).all();

  function requestRows(req, rows, done) {
    if (rows.length === 0) return html`<p class="muted">${done ? 'Nema završenih upita.' : 'Nema otvorenih upita.'}</p>`;
    return html`<div class="table-wrap"><table>
      <thead><tr><th>Član</th><th>Traženi termin</th><th>Upit poslan</th><th></th></tr></thead>
      <tbody>${rows.map((r) => html`<tr>
        <td><strong>${r.member_name}</strong><br><span class="small muted">${r.username || ''}${r.phone ? ` · ${r.phone}` : ''}</span></td>
        <td>${slotLabel({ date: r.slot_date, start_time: r.slot_start, end_time: r.slot_end })}</td>
        <td>${formatSarajevo(r.requested_at)}</td>
        <td class="actions">
          <form method="post" action="/admin/privatni-casovi/upit/${r.id}/${done ? 'otvoreno' : 'zavrseno'}" class="inline-form">
            ${csrfField(req)}<button class="btn ${done ? 'btn-ghost' : 'btn-primary'} btn-sm" type="submit">${done ? 'Vrati u otvorene' : '✓ Označi kao završeno'}</button>
          </form>
        </td></tr>`)}</tbody></table></div>`;
  }

  function page(req, { values = {}, errors = [] } = {}) {
    const now = Date.now();
    const slots = allSlots.all();
    const open = requestsWhere(false);
    const done = requestsWhere(true);
    return layout(req, {
      title: 'Privatni časovi',
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>Privatni časovi</h1>
        <p class="muted">Slobodne termine vide samo prijavljeni članovi (ne djeca) pod „Zatraži privatni čas“ – dok nisu blokirani
          i dok ne počnu (sarajevsko vrijeme). Upit ne blokira termin; zakazani čas unosiš sam/a pod „Termini“.</p>
      </div></div>

      <section class="card" id="otvoreni-upiti">
        <h2>Otvoreni upiti (${open.length})</h2>
        ${requestRows(req, open, false)}
      </section>

      <section class="card">
        <h2>Novi slobodni termin</h2>
        ${errorList(errors)}
        <form method="post" action="/admin/privatni-casovi" class="form-grid">
          ${csrfField(req)}
          <label>Datum *<input name="date" type="date" required value="${values.date || ''}"></label>
          <div class="btn-row">
            <label>Od *<input name="start_time" type="time" required value="${values.start_time || ''}"></label>
            <label>Do *<input name="end_time" type="time" required value="${values.end_time || ''}"></label>
          </div>
          <div class="span-2"><button class="btn btn-primary" type="submit">Dodaj termin</button></div>
        </form>
      </section>

      <section class="card">
        <h2>Slobodni termini</h2>
        ${slots.length === 0
          ? html`<p class="muted">Još nema slobodnih termina.</p>`
          : html`<div class="table-wrap"><table>
            <thead><tr><th>Termin</th><th>Status</th><th class="num">Upiti</th><th></th></tr></thead>
            <tbody>${slots.map((s) => {
              const past = slotStartMs(s) <= now;
              return html`<tr class="${past || s.blocked ? 'is-inactive' : ''}">
                <td>${slotLabel(s)}</td>
                <td>${past ? html`<span class="tag">prošao</span>`
                  : s.blocked ? html`<span class="tag tag-cancelled">blokiran</span>`
                  : isSlotOpen(s, now) ? html`<span class="tag tag-done">vidljiv članovima</span>` : ''}</td>
                <td class="num">${s.requests}</td>
                <td class="actions">
                  ${past ? '' : html`<form method="post" action="/admin/privatni-casovi/${s.id}/${s.blocked ? 'odblokiraj' : 'blokiraj'}" class="inline-form">
                    ${csrfField(req)}<button class="btn btn-ghost btn-sm" type="submit">${s.blocked ? 'Ukloni blokadu' : 'Blokiraj'}</button></form>`}
                  <form method="post" action="/admin/privatni-casovi/${s.id}/obrisi" class="inline-form" data-confirm="Obrisati termin ${slotLabel(s)}? Upiti ostaju sačuvani.">
                    ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button></form>
                </td></tr>`;
            })}</tbody></table></div>`}
      </section>

      <section class="card" id="zavrseni-upiti">
        <h2>Završeni upiti (${done.length})</h2>
        ${requestRows(req, done, true)}
      </section>`,
    });
  }

  router.get('/', (req, res) => {
    res.send(String(page(req)));
  });

  router.post('/', (req, res) => {
    const values = {
      date: typeof req.body.date === 'string' ? req.body.date.trim() : '',
      start_time: typeof req.body.start_time === 'string' ? req.body.start_time.trim() : '',
      end_time: typeof req.body.end_time === 'string' ? req.body.end_time.trim() : '',
    };
    const errors = [];
    if (!D.isValidDate(values.date)) errors.push('Neispravan datum.');
    if (!TIME_RE.test(values.start_time) || !TIME_RE.test(values.end_time)) errors.push('Neispravno vrijeme (od–do).');
    else if (values.end_time <= values.start_time) errors.push('Kraj mora biti poslije početka.');
    if (errors.length) {
      res.status(400);
      return res.send(String(page(req, { values, errors })));
    }
    db.prepare('INSERT INTO private_slots (date, start_time, end_time) VALUES (?, ?, ?)').run(values.date, values.start_time, values.end_time);
    res.flash('success', `Slobodni termin ${slotLabel(values)} je dodan.`);
    res.redirect('/admin/privatni-casovi');
  });

  const slotAction = (fn) => (req, res) => {
    const slot = getSlot.get(toId(req.params.id));
    if (!slot) return res.status(404).send('Nije pronađeno: termin.');
    res.flash('success', fn(slot));
    res.redirect('/admin/privatni-casovi');
  };
  router.post('/:id/blokiraj', slotAction((s) => {
    db.prepare('UPDATE private_slots SET blocked = 1 WHERE id = ?').run(s.id);
    return `Termin ${slotLabel(s)} je blokiran – članovi ga više ne vide.`;
  }));
  router.post('/:id/odblokiraj', slotAction((s) => {
    db.prepare('UPDATE private_slots SET blocked = 0 WHERE id = ?').run(s.id);
    return `Blokada termina ${slotLabel(s)} je uklonjena.`;
  }));
  router.post('/:id/obrisi', slotAction((s) => {
    db.prepare('DELETE FROM private_slots WHERE id = ?').run(s.id);
    return `Termin ${slotLabel(s)} je obrisan.`;
  }));

  const requestAction = (done) => (req, res) => {
    const id = toId(req.params.id);
    const r = id && db.prepare('SELECT * FROM private_requests WHERE id = ?').get(id);
    if (!r) return res.status(404).send('Nije pronađeno: upit.');
    db.prepare('UPDATE private_requests SET done = ?, done_at = ? WHERE id = ?').run(done ? 1 : 0, done ? new Date().toISOString() : null, r.id);
    res.flash('success', done ? 'Upit je označen kao završen.' : 'Upit je ponovo otvoren.');
    res.redirect('/admin/privatni-casovi');
  };
  router.post('/upit/:id/zavrseno', requestAction(true));
  router.post('/upit/:id/otvoreno', requestAction(false));

  return router;
};
