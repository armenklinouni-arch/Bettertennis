'use strict';

// Admin: „Ko je pogledao“ – ko je otvorio sedmični raspored (po sedmici) i mjesečne iznose (po mjesecu).
// Samo pregled za admina; podaci dolaze iz page_views (vidi src/page-views.js).
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { layout, monthNav } = require('../views');
const { requireAdmin } = require('../auth');
const { monthlyStatement } = require('../billing');
const { viewsByPlayer, parentViews, cleanupViews, KEEP_MONTHS } = require('../page-views');

const BASE = '/admin/ko-je-pogledao';

// „08.12.2026. 18:30“ po sarajevskom vremenu.
function formatWhen(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Sarajevo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year}. ${p.hour}:${p.minute}`;
}

// Preko kojeg računa je pogledano: „sam igrač“, „roditelj: Porodica …“, „dječiji račun: …“.
function viewerLabel(v) {
  if (v.viewer_type === 'clan') return 'sam igrač';
  if (v.viewer_type === 'roditelj') return `roditelj: ${v.viewer_name || '–'}`;
  return v.viewer_name ? `dječiji račun: ${v.viewer_name}` : 'dječiji račun';
}

module.exports = function viewsAdminRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const weekPlayers = db.prepare(
    `SELECT DISTINCT u.* FROM lessons l JOIN users u ON u.id = l.user_id
      WHERE l.date BETWEEN ? AND ? AND u.role = 'member'
      ORDER BY u.name COLLATE NOCASE, u.id`
  );
  const parentAccounts = db.prepare('SELECT id, name, active FROM parent_accounts ORDER BY name COLLATE NOCASE, id');
  const parentPlayers = db.prepare(
    `SELECT p.parent_account_id, u.name FROM parent_account_players p JOIN users u ON u.id = p.user_id
      WHERE u.role = 'member' ORDER BY u.name COLLATE NOCASE, u.id`
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
      const seen = viewsByPlayer(db, 'raspored', monday);
      rows = weekPlayers.all(monday, D.addDays(monday, 6)).map((player) => ({ player, views: seen.get(player.id) || [] }));
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
      const seen = viewsByPlayer(db, 'iznosi', month);
      // Isti igrači kao u listi „Iznosi“: aktivni članovi i svi s iznosom u tom mjesecu.
      rows = members.all().map((player) => ({ player, st: monthlyStatement(db, player, month) }))
        .filter((r) => r.player.active || r.st.total !== 0)
        .map((r) => ({ ...r, views: seen.get(r.player.id) || [] }));
      nav = monthNav(BASE, month, '&prikaz=iznosi');
    }
    const seenCount = rows.filter((r) => r.views.length).length;
    // Svi roditeljski računi s dodijeljenim igračima i posljednjim otvaranjem za ovu sedmicu odn. mjesec.
    const parentSeen = parentViews(db, tab, tab === 'raspored' ? monday : month);
    const playersOf = new Map();
    for (const r of parentPlayers.all()) {
      if (!playersOf.has(r.parent_account_id)) playersOf.set(r.parent_account_id, []);
      playersOf.get(r.parent_account_id).push(r.name);
    }
    const parents = parentAccounts.all().map((a) => ({ account: a, at: parentSeen.get(a.id), players: playersOf.get(a.id) || [] }));

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
          : rows.map(({ player, views, st }) => html`<tr data-player="${player.id}" class="${views.length ? 'is-seen' : 'is-unseen'}">
            <td><strong>${player.name}</strong>${player.parent_id ? html` <span class="tag tag-child">Dječiji račun</span>` : ''}</td>
            <td>${views.length
              ? html`<ul class="seen-list">${views.map((v) => html`<li><span class="tag tag-yes">Pogledao ${formatWhen(v.at)}</span> <span class="seen-by">${viewerLabel(v)}</span></li>`)}</ul>`
              : html`<span class="tag tag-no">Nije pogledao</span>${st && !st.released ? html` <span class="muted small">· obračun još u pripremi</span>` : ''}`}</td>
          </tr>`)}</tbody>
      </table></div>
      <section class="card seen-parents">
        <h2>Roditeljski računi</h2>
        <p class="muted small">${tab === 'raspored'
          ? 'Ko je od roditeljskih računa otvorio sedmični raspored ove sedmice.'
          : 'Ko je od roditeljskih računa otvorio finansije (odobrene iznose) za ovaj mjesec.'}</p>
        <div class="table-wrap"><table class="seen-table">
          <thead><tr><th>Roditeljski račun</th><th>${tab === 'raspored' ? 'Sedmični raspored' : 'Finansije'}</th><th>Igrači</th></tr></thead>
          <tbody>${parents.length === 0
            ? html`<tr><td colspan="3" class="empty">Još nema roditeljskih računa.</td></tr>`
            : parents.map(({ account, at, players }) => html`<tr data-parent="${account.id}" class="${at ? 'is-seen' : 'is-unseen'}">
              <td><strong>${account.name}</strong>${account.active ? '' : html` <span class="tag tag-none">Neaktivan</span>`}</td>
              <td>${at ? html`<span class="tag tag-yes">Pogledao ${formatWhen(at)}</span>` : html`<span class="tag tag-no">Nije pogledao</span>`}</td>
              <td>${players.length ? players.join(', ') : '–'}</td>
            </tr>`)}</tbody>
        </table></div>
      </section>`,
    })));
  });

  return router;
};
