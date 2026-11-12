'use strict';

// Admin: „Ko je pogledao“ – ko je otvorio sedmični raspored (po sedmici) i mjesečne iznose (po mjesecu).
// Samo pregled za admina; podaci dolaze iz page_views (vidi src/page-views.js).
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { layout, monthNav } = require('../views');
const { requireAdmin } = require('../auth');
const { monthlyStatement } = require('../billing');
const { latestViews, cleanupViews, KEEP_MONTHS } = require('../page-views');

const BASE = '/admin/ko-je-pogledao';

// „08.12.2026. 18:30“ po sarajevskom vremenu.
function formatWhen(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Sarajevo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year}. ${p.hour}:${p.minute}`;
}

const VIEWER_LABEL = { dijete: 'Dječiji račun', roditelj: 'Roditeljski račun' };

module.exports = function viewsAdminRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const weekPlayers = db.prepare(
    `SELECT DISTINCT u.* FROM lessons l JOIN users u ON u.id = l.user_id
      WHERE l.date BETWEEN ? AND ? AND u.role = 'member'
      ORDER BY u.name COLLATE NOCASE, u.id`
  );
  const members = db.prepare(
    "SELECT * FROM users WHERE role = 'member' AND parent_id IS NULL ORDER BY name COLLATE NOCASE, id"
  );

  router.get('/', (req, res) => {
    cleanupViews(db);
    const today = D.todayISO();
    const tab = req.query.prikaz === 'iznosi' ? 'iznosi' : 'raspored';
    const monday = D.mondayOf(D.isValidDate(req.query.woche) ? req.query.woche : today);
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(today);
    const tabUrl = (t) => (t === 'iznosi'
      ? `${BASE}?prikaz=iznosi&monat=${tab === 'iznosi' ? month : D.monthOf(monday)}`
      : `${BASE}?prikaz=raspored&woche=${tab === 'raspored' ? monday : D.mondayOf(`${month}-01`)}`);

    let rows;
    let nav;
    if (tab === 'raspored') {
      const seen = latestViews(db, 'raspored', monday);
      rows = weekPlayers.all(monday, D.addDays(monday, 6)).map((player) => ({ player, view: seen.get(player.id) }));
      const q = (w) => `${BASE}?prikaz=raspored&woche=${w}`;
      const thisMonday = D.mondayOf(today);
      nav = html`<div class="week-head seen-nav">
        <a class="btn btn-ghost btn-sm" href="${q(D.addDays(monday, -7))}" aria-label="Prethodna sedmica">‹ Prethodna</a>
        <div class="week-title">
          <strong>${D.isoWeekNumber(monday)}. sedmica</strong>
          <span>${D.formatDate(monday)} – ${D.formatDate(D.addDays(monday, 6))}</span>
          ${monday !== thisMonday ? html`<a href="${q(thisMonday)}" class="today-link">Ova sedmica</a>` : ''}
        </div>
        <a class="btn btn-ghost btn-sm" href="${q(D.addDays(monday, 7))}" aria-label="Sljedeća sedmica">Sljedeća ›</a>
      </div>`;
    } else {
      const seen = latestViews(db, 'iznosi', month);
      // Isti igrači kao u listi „Iznosi“: aktivni članovi i svi s iznosom u tom mjesecu.
      rows = members.all().map((player) => ({ player, st: monthlyStatement(db, player, month) }))
        .filter((r) => r.player.active || r.st.total !== 0)
        .map((r) => ({ ...r, view: seen.get(r.player.id) }));
      nav = monthNav(BASE, month, '&prikaz=iznosi');
    }
    const seenCount = rows.filter((r) => r.view).length;

    res.send(String(layout(req, {
      title: 'Ko je pogledao',
      body: html`
      <div class="page-head"><div>
        <h1>Ko je pogledao</h1>
        <p class="muted">Ko je otvorio sedmični raspored odn. mjesečne iznose (član, njegov dječiji ili roditeljski račun).
          Prikazuje se posljednje otvaranje (sarajevsko vrijeme). Bilježi se samo da je stranica otvorena;
          zapisi stariji od ${KEEP_MONTHS} mjeseca se brišu automatski.</p>
      </div></div>
      <nav class="tabs" aria-label="Prikaz">
        <a class="${tab === 'raspored' ? 'tab is-active' : 'tab'}" href="${tabUrl('raspored')}"${tab === 'raspored' ? html` aria-current="page"` : ''}>Raspored</a>
        <a class="${tab === 'iznosi' ? 'tab is-active' : 'tab'}" href="${tabUrl('iznosi')}"${tab === 'iznosi' ? html` aria-current="page"` : ''}>Iznosi</a>
      </nav>
      ${nav}
      <p class="seen-count">Pogledalo: <strong>${seenCount}</strong> od <strong>${rows.length}</strong></p>
      <div class="table-wrap"><table class="seen-table">
        <thead><tr><th>Igrač</th><th>${tab === 'raspored' ? 'Sedmični raspored' : 'Mjesečni iznos'}</th></tr></thead>
        <tbody>${rows.length === 0
          ? html`<tr><td colspan="2" class="empty">${tab === 'raspored' ? 'U ovoj sedmici nema termina.' : 'Nema članova za ovaj mjesec.'}</td></tr>`
          : rows.map(({ player, view, st }) => html`<tr data-player="${player.id}" class="${view ? 'is-seen' : 'is-unseen'}">
            <td><strong>${player.name}</strong>${player.parent_id ? html` <span class="tag tag-child">Dječiji račun</span>` : ''}</td>
            <td>${view
              ? html`<span class="tag tag-yes">Pogledao ${formatWhen(view.at)}</span>${VIEWER_LABEL[view.viewer_type]
                ? html` <span class="muted small">· ${VIEWER_LABEL[view.viewer_type]}: ${view.viewer_name || '–'}</span>` : ''}`
              : html`<span class="tag tag-no">Nije pogledao</span>${st && !st.released ? html` <span class="muted small">· obračun još u pripremi</span>` : ''}`}</td>
          </tr>`)}</tbody>
      </table></div>`,
    })));
  });

  return router;
};
