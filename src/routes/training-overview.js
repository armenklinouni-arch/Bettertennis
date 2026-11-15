'use strict';

// Admin: „Treninzi po igraču“ – koliko grupnih i individualnih treninga ima svaki igrač u odabranoj sedmici.
// Otkazani termini se ne broje; dječiji računi nisu u listi. Klik na broj prikazuje pojedinačne termine.
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { layout, listFilter, lessonTimeRange, lessonKindLabel } = require('../views');
const { requireAdmin } = require('../auth');
const { searchText, matchesSearch, sortByName } = require('../search');

const BASE = '/admin/treninzi-po-igracu';
const KINDS = ['group', 'individual', 'all'];

module.exports = function trainingOverviewRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const players = db.prepare("SELECT * FROM users WHERE role = 'member' AND parent_id IS NULL");
  const weekLessons = db.prepare(
    `SELECT l.* FROM lessons l JOIN users u ON u.id = l.user_id
      WHERE l.date BETWEEN ? AND ? AND l.cancelled = 0 AND u.role = 'member' AND u.parent_id IS NULL
      ORDER BY l.date, l.start_time, l.id`
  );

  router.get('/', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(D.isValidDate(req.query.woche) ? req.query.woche : today);
    const sunday = D.addDays(monday, 6);
    const q = typeof req.query.trazi === 'string' ? req.query.trazi.trim().slice(0, 100) : '';
    const openId = Number(req.query.igrac) || null;
    const openKind = KINDS.includes(req.query.vrsta) ? req.query.vrsta : 'all';

    const byPlayer = new Map();
    for (const l of weekLessons.all(monday, sunday)) {
      if (!byPlayer.has(l.user_id)) byPlayer.set(l.user_id, []);
      byPlayer.get(l.user_id).push(l);
    }
    // Aktivni igrači i svi koji u ovoj sedmici imaju termin.
    const rows = sortByName(players.all().filter((p) => p.active || byPlayer.has(p.id))).map((p) => {
      const lessons = byPlayer.get(p.id) || [];
      const group = lessons.filter((l) => l.kind === 'group').length;
      return { player: p, lessons, group, individual: lessons.length - group, text: searchText(p.name, p.username) };
    });
    const withoutTraining = rows.filter((r) => r.lessons.length === 0).length;

    const weekUrl = (w) => `${BASE}?woche=${w}`;
    const filterParam = q ? `&trazi=${encodeURIComponent(q)}` : '';
    const detailUrl = (p, kind) => `${weekUrl(monday)}${filterParam}&igrac=${p.id}&vrsta=${kind}#igrac-${p.id}`;
    const count = (r, kind, n) => (n > 0
      ? html`<a href="${detailUrl(r.player, kind)}" title="Prikaži termine">${n}</a>`
      : html`${n}`);
    const thisMonday = D.mondayOf(today);

    res.send(String(layout(req, {
      title: 'Treninzi po igraču',
      body: html`
      <div class="page-head"><div>
        <h1>Treninzi po igraču</h1>
        <p class="muted">Broj treninga po igraču u odabranoj sedmici (bez otkazanih termina i bez dječijih računa).
          Klik na broj prikazuje pojedinačne termine.</p>
      </div></div>
      <div class="week-head seen-nav">
        <a class="btn btn-ghost btn-sm" href="${weekUrl(D.addDays(monday, -7))}" aria-label="Prethodna sedmica">‹ Prethodna</a>
        <div class="week-title">
          <strong>${D.isoWeekNumber(monday)}. sedmica</strong>
          <span>${D.formatDate(monday)} – ${D.formatDate(sunday)}</span>
          ${monday !== thisMonday ? html`<a href="${weekUrl(thisMonday)}" class="today-link">Ova sedmica</a>` : ''}
        </div>
        <a class="btn btn-ghost btn-sm" href="${weekUrl(D.addDays(monday, 7))}" aria-label="Sljedeća sedmica">Sljedeća ›</a>
      </div>
      ${listFilter({ key: 'treninzi', action: BASE, value: q, clearHref: weekUrl(monday), hidden: { woche: monday } })}
      <p class="muted">Igrači: ${rows.length} · bez treninga u ovoj sedmici: ${withoutTraining}</p>
      <div class="table-wrap"><table class="training-count">
        <thead><tr><th>Ime</th><th class="num">Grupni trening</th><th class="num">Individualni trening</th><th class="num">Ukupno</th></tr></thead>
        <tbody data-filter-list="treninzi">${rows.length === 0
          ? html`<tr><td colspan="4" class="empty">Nema igrača.</td></tr>`
          : rows.map((r) => {
            const hidden = q && !matchesSearch(r.text, q);
            const open = openId === r.player.id && r.lessons.length > 0;
            const shown = open ? r.lessons.filter((l) => openKind === 'all' || l.kind === openKind) : [];
            return html`<tr id="igrac-${r.player.id}" data-filter="${r.text}" class="${r.lessons.length ? '' : 'is-zero'}${r.player.active ? '' : ' is-inactive'}"${hidden ? html` hidden` : ''}>
              <td><strong>${r.player.name}</strong></td>
              <td class="num">${count(r, 'group', r.group)}</td>
              <td class="num">${count(r, 'individual', r.individual)}</td>
              <td class="num">${count(r, 'all', r.lessons.length)}</td>
            </tr>${open ? html`<tr class="lesson-detail" data-filter="${r.text}"${hidden ? html` hidden` : ''}>
              <td colspan="4">
                <p class="small muted">${r.player.name} · ${openKind === 'group' ? 'grupni treninzi' : openKind === 'individual' ? 'individualni treninzi' : 'svi treninzi'} u ovoj sedmici:</p>
                <ul class="list">${shown.map((l) => html`<li>${D.formatDateLong(l.date)} · ${lessonTimeRange(l)} h${l.court ? ` · Teren ${l.court}` : ''} · ${lessonKindLabel(l)}</li>`)}</ul>
                <a class="btn btn-ghost btn-sm" href="${weekUrl(monday)}${filterParam}#igrac-${r.player.id}">Zatvori</a>
              </td>
            </tr>` : ''}`;
          })}</tbody>
      </table></div>`,
    })));
  });

  return router;
};
