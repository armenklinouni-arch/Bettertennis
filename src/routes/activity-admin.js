'use strict';

// Admin: Dnevnik aktivnosti – samo pregled (nema izmjene ni brisanja zapisa).
const express = require('express');
const { html } = require('../html');
const { layout } = require('../views');
const { requireAdmin } = require('../auth');
const { AREAS, KEEP_MONTHS, cleanupActivity } = require('../activity');
const { normalizeSearch } = require('../search');

const PAGE_SIZE = 100;

// „27.10.2026. 14:05“ po sarajevskom vremenu.
function formatWhen(iso) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Sarajevo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('day')}.${get('month')}.${get('year')}. ${get('hour')}:${get('minute')}`;
}

module.exports = function activityAdminRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get('/', (req, res) => {
    cleanupActivity(db);
    const area = AREAS.includes(req.query.oblast) ? req.query.oblast : '';
    const q = typeof req.query.trazi === 'string' ? req.query.trazi.trim().slice(0, 100) : '';
    const page = Math.max(1, parseInt(req.query.strana, 10) || 1);
    const where = [];
    const params = [];
    if (area) { where.push('area = ?'); params.push(area); }
    for (const term of normalizeSearch(q).split(' ').filter(Boolean)) {
      where.push("search LIKE ? ESCAPE '\\'");
      params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM activity_log ${sqlWhere} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE);
    const more = rows.length > PAGE_SIZE;
    const query = (p) => `/admin/dnevnik?${new URLSearchParams({ ...(area ? { oblast: area } : {}), ...(q ? { trazi: q } : {}), strana: String(p) })}`;

    res.send(String(layout(req, {
      title: 'Dnevnik aktivnosti',
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>Dnevnik aktivnosti</h1>
        <p class="muted">Sve izmjene, najnovije gore (sarajevsko vrijeme). Samo za pregled – zapisi se ne mogu mijenjati.
          Zapisi stariji od ${KEEP_MONTHS} mjeseci se brišu automatski. Lozinke se nikad ne bilježe.</p>
      </div></div>
      <form method="get" action="/admin/dnevnik" class="log-filter" role="search">
        <label>Oblast
          <select name="oblast">
            <option value="">Sve oblasti</option>
            ${AREAS.map((a) => html`<option value="${a}"${a === area ? ' selected' : ''}>${a}</option>`)}
          </select>
        </label>
        <label>Ime
          <input name="trazi" type="text" autocomplete="off" placeholder="npr. Hadžić" value="${q}">
        </label>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" type="submit">Prikaži</button>
          ${area || q ? html`<a class="btn btn-ghost btn-sm" href="/admin/dnevnik">Poništi filter</a>` : ''}
        </div>
      </form>
      <div class="table-wrap"><table class="activity-log">
        <thead><tr><th>Vrijeme</th><th>Ko</th><th>Oblast</th><th>Opis</th></tr></thead>
        <tbody>${rows.length === 0
          ? html`<tr><td colspan="4" class="empty">Nema zapisa${area || q ? ' za ovaj filter' : ''}.</td></tr>`
          : rows.slice(0, PAGE_SIZE).map((r) => html`<tr data-log="${r.id}">
            <td class="when">${formatWhen(r.at)}</td>
            <td>${r.actor_name}</td>
            <td><span class="tag">${r.area}</span></td>
            <td>${r.area}: ${r.text}</td>
          </tr>`)}</tbody>
      </table></div>
      <div class="btn-row">
        ${page > 1 ? html`<a class="btn btn-ghost btn-sm" href="${query(page - 1)}">← Novije</a>` : ''}
        ${more ? html`<a class="btn btn-ghost btn-sm" href="${query(page + 1)}">Starije →</a>` : ''}
      </div>`,
    })));
  });

  return router;
};
