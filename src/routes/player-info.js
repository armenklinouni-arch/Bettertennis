'use strict';

// Admin: „Informacije o igračima“ – školska smjena (fiksna ili sedmična izmjena plava/zelena sedmica),
// kad igrač može na trening i napomena. Samo admin; nigdje se ne prikazuje članovima, roditeljima, djeci ni trenerima.
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { layout, csrfField, errorList, listFilter } = require('../views');
const { requireAdmin } = require('../auth');
const { searchText, matchesSearch, sortByName } = require('../search');
const { logActivity } = require('../activity');

const BASE = '/admin/informacije-igraci';
const SHIFTS = { morning: 'Jutarnja', afternoon: 'Popodnevna' };
const SHIFT_SETTINGS = { morning: 'Jutarnja', afternoon: 'Popodnevna', alternating: 'Mijenja se sedmično' };
const FILTERS = { morning: 'Jutarnja', afternoon: 'Popodnevna', none: 'Nije uneseno' };

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const toId = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// Parna kalendarska sedmica = plava, neparna = zelena (kao u „Termini“).
const isBlueWeek = (monday) => D.isoWeekNumber(monday) % 2 === 0;

// Smjena u sedmici (ponedjeljak): 'morning', 'afternoon' ili null.
function shiftInWeek(info, monday) {
  if (!info || !info.shift) return null;
  if (info.shift !== 'alternating') return info.shift;
  return (isBlueWeek(monday) ? info.shift_even : info.shift_odd) || null;
}

function shiftSettingLabel(info) {
  if (!info || !info.shift) return '–';
  if (info.shift !== 'alternating') return SHIFT_SETTINGS[info.shift];
  return `Mijenja se sedmično (plava: ${SHIFTS[info.shift_even] || '–'}, zelena: ${SHIFTS[info.shift_odd] || '–'})`;
}

module.exports = function playerInfoRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  const players = db.prepare("SELECT * FROM users WHERE role = 'member' AND parent_id IS NULL");
  const getPlayer = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'member' AND parent_id IS NULL");
  const getInfo = db.prepare('SELECT * FROM player_info WHERE user_id = ?');
  const allInfo = () => new Map(db.prepare('SELECT * FROM player_info').all().map((r) => [r.user_id, r]));

  router.get('/', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(D.isValidDate(req.query.woche) ? req.query.woche : today);
    const shiftFilter = FILTERS[req.query.smjena] ? req.query.smjena : '';
    const q = text(req.query.trazi, 100);
    const infos = allInfo();
    const nextMonday = D.addDays(monday, 7);
    // Aktivni igrači i neaktivni za koje su informacije već unesene.
    const all = sortByName(players.all().filter((p) => p.active || infos.has(p.id))).map((p) => {
      const info = infos.get(p.id) || null;
      return { player: p, info, now: shiftInWeek(info, monday), next: shiftInWeek(info, nextMonday), text: searchText(p.name, p.username) };
    });
    const rows = all.filter((r) => !shiftFilter || (shiftFilter === 'none' ? !r.now : r.now === shiftFilter));
    const blue = isBlueWeek(monday);
    const extra = shiftFilter ? `&smjena=${shiftFilter}` : '';
    const weekUrl = (w) => `${BASE}?woche=${w}${extra}`;
    const back = `${BASE}?woche=${monday}${extra}`;
    const thisMonday = D.mondayOf(today);

    res.send(String(layout(req, {
      title: 'Informacije o igračima',
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>Informacije o igračima</h1>
        <p class="muted">Školska smjena, kad igrač može na trening i napomene – samo za admina. Za odabranu sedmicu
          prikazuje se smjena koju igrač tada ima (parna sedmica = plava, neparna = zelena).</p>
      </div></div>
      <div class="week-head seen-nav">
        <a class="btn btn-ghost btn-sm" href="${weekUrl(D.addDays(monday, -7))}" aria-label="Prethodna sedmica">‹ Prethodna</a>
        <div class="week-title">
          <strong>${D.isoWeekNumber(monday)}. sedmica <small class="week-tone-label">${blue ? 'plava sedmica' : 'zelena sedmica'}</small></strong>
          <span>${D.formatDate(monday)} – ${D.formatDate(D.addDays(monday, 6))}</span>
          ${monday !== thisMonday ? html`<a href="${weekUrl(thisMonday)}" class="today-link">Ova sedmica</a>` : ''}
        </div>
        <a class="btn btn-ghost btn-sm" href="${weekUrl(D.addDays(monday, 7))}" aria-label="Sljedeća sedmica">Sljedeća ›</a>
      </div>
      <div class="info-filters">
        <form method="get" action="${BASE}" class="inline-form shift-filter">
          <input type="hidden" name="woche" value="${monday}">
          ${q ? html`<input type="hidden" name="trazi" value="${q}">` : ''}
          <label>Smjena u ovoj sedmici
            <select name="smjena">
              <option value="">Sve</option>
              ${Object.entries(FILTERS).map(([k, label]) => html`<option value="${k}"${shiftFilter === k ? ' selected' : ''}>${label}</option>`)}
            </select>
          </label>
          <button class="btn btn-ghost btn-sm" type="submit">Prikaži</button>
        </form>
        ${listFilter({ key: 'informacije', action: BASE, value: q, clearHref: back, hidden: { woche: monday, ...(shiftFilter ? { smjena: shiftFilter } : {}) } })}
      </div>
      <p class="muted">Prikazano: ${rows.length} od ${all.length}</p>
      <div class="table-wrap"><table class="player-info">
        <thead><tr><th>Ime</th><th>Smjena ove sedmice</th><th>Smjena naredne sedmice</th><th>Školska smjena</th><th>Kad može na trening</th><th>Napomena</th><th></th></tr></thead>
        <tbody data-filter-list="informacije">${rows.length === 0
          ? html`<tr><td colspan="7" class="empty">Nema igrača za ovaj filter.</td></tr>`
          : rows.map((r) => html`<tr id="igrac-${r.player.id}" data-filter="${r.text}" class="${r.player.active ? '' : 'is-inactive'}"${q && !matchesSearch(r.text, q) ? html` hidden` : ''}>
            <td><a href="${BASE}/${r.player.id}?back=${encodeURIComponent(back)}"><strong>${r.player.name}</strong></a></td>
            <td class="shift-now">${r.now ? html`<span class="tag shift-tag is-${r.now}">${SHIFTS[r.now]}</span>` : '–'}</td>
            <td class="shift-next">${r.next ? html`<span class="tag shift-tag is-${r.next}">${SHIFTS[r.next]}</span>` : '–'}</td>
            <td>${shiftSettingLabel(r.info)}</td>
            <td class="pre">${r.info && r.info.availability ? r.info.availability : ''}</td>
            <td class="pre">${r.info && r.info.note ? r.info.note : ''}</td>
            <td class="actions"><a class="btn btn-ghost btn-sm" href="${BASE}/${r.player.id}?back=${encodeURIComponent(back)}">Uredi</a></td>
          </tr>`)}</tbody>
      </table></div>`,
    })));
  });

  const safeBack = (v) => (typeof v === 'string' && v.startsWith(`${BASE}?`) ? v : BASE);

  function editPage(req, player, values, errors = []) {
    const back = safeBack(req.query.back || (req.body && req.body.back));
    const shiftSelect = (name, selected) => html`<select name="${name}">
        <option value="">– odaberi –</option>
        ${Object.entries(SHIFTS).map(([k, label]) => html`<option value="${k}"${selected === k ? ' selected' : ''}>${label}</option>`)}
      </select>`;
    return layout(req, {
      title: `Informacije: ${player.name}`,
      body: html`
      <div class="page-head">
        <h1>Informacije o igraču: ${player.name}</h1>
        <a class="btn btn-ghost" href="${back}">← Nazad na listu</a>
      </div>
      <section class="card">
        ${errorList(errors)}
        <form method="post" action="${BASE}/${player.id}" class="form-grid">
          ${csrfField(req)}<input type="hidden" name="back" value="${back}">
          <label class="span-2">Školska smjena
            <select name="shift">
              <option value="">– nije uneseno –</option>
              ${Object.entries(SHIFT_SETTINGS).map(([k, label]) => html`<option value="${k}"${values.shift === k ? ' selected' : ''}>${label}</option>`)}
            </select>
          </label>
          <fieldset class="span-2 shift-alternating">
            <legend>Samo kod „Mijenja se sedmično“</legend>
            <label>Parne sedmice (plava sedmica) ${shiftSelect('shift_even', values.shift_even)}</label>
            <label>Neparne sedmice (zelena sedmica) ${shiftSelect('shift_odd', values.shift_odd)}</label>
          </fieldset>
          <label class="span-2">Kad može na trening
            <textarea name="availability" rows="3" maxlength="1000" placeholder="npr. radnim danima od 17 h, subotom ne">${values.availability || ''}</textarea>
          </label>
          <label class="span-2">Napomena
            <textarea name="note" rows="4" maxlength="2000">${values.note || ''}</textarea>
          </label>
          <div class="span-2 btn-row"><button class="btn btn-primary" type="submit">Sačuvaj</button>
            <a class="btn btn-ghost" href="${back}">Odustani</a></div>
        </form>
      </section>`,
    });
  }

  router.get('/:id', (req, res) => {
    const player = getPlayer.get(toId(req.params.id));
    if (!player) return res.status(404).send('Nije pronađeno: igrač.');
    res.send(String(editPage(req, player, getInfo.get(player.id) || {})));
  });

  router.post('/:id', (req, res) => {
    const player = getPlayer.get(toId(req.params.id));
    if (!player) return res.status(404).send('Nije pronađeno: igrač.');
    const values = {
      shift: SHIFT_SETTINGS[req.body.shift] ? req.body.shift : null,
      shift_even: SHIFTS[req.body.shift_even] ? req.body.shift_even : null,
      shift_odd: SHIFTS[req.body.shift_odd] ? req.body.shift_odd : null,
      availability: text(req.body.availability, 1000),
      note: text(req.body.note, 2000),
    };
    if (values.shift !== 'alternating') {
      values.shift_even = null;
      values.shift_odd = null;
    } else if (!values.shift_even || !values.shift_odd) {
      res.status(400);
      return res.send(String(editPage(req, player, values, ['Odaberi smjenu za plavu i za zelenu sedmicu.'])));
    }
    db.prepare(
      `INSERT INTO player_info (user_id, shift, shift_even, shift_odd, availability, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET shift = excluded.shift, shift_even = excluded.shift_even, shift_odd = excluded.shift_odd,
         availability = excluded.availability, note = excluded.note, updated_at = excluded.updated_at`
    ).run(player.id, values.shift, values.shift_even, values.shift_odd, values.availability || null, values.note || null);
    logActivity(db, req, 'Članovi', `${player.name} – informacije o igraču sačuvane (smjena: ${shiftSettingLabel(values)})`);
    res.flash('success', `Informacije za ${player.name} su sačuvane.`);
    res.redirect(`${safeBack(req.body.back)}#igrac-${player.id}`);
  });

  return router;
};

module.exports.shiftInWeek = shiftInWeek;
