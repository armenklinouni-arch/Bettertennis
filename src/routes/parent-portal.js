'use strict';

// Roditeljski račun (Elternkonto): isključivo čitanje. Vidi samo igrače koje mu je admin dodijelio –
// njihov zajednički sedmični raspored i mjesečne iznose, s izborom igrača za zbir.
// Izbor igrača se nigdje ne čuva: dolazi samo iz URL-a i za svaki mjesec se može slobodno mijenjati.
const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { monthlyStatement, formatHours } = require('../billing');
const { layout, weekView, monthNav, paymentBadge, statementTable } = require('../views');
const { requireParentAccount } = require('../auth');
const { isWeekReleased } = require('../weeks');
const { recordView } = require('../page-views');
const { holidaysBetween } = require('../holidays');

module.exports = function parentPortalRoutes(db) {
  const router = express.Router();
  router.use(requireParentAccount);

  // Svi upiti su vezani za parent_account_id prijavljenog računa – tuđi igrači se nikad ne učitavaju.
  const myPlayers = db.prepare(
    `SELECT u.* FROM parent_account_players p JOIN users u ON u.id = p.user_id
      WHERE p.parent_account_id = ? AND u.role = 'member'
      ORDER BY u.name COLLATE NOCASE, u.id`
  );
  const playerLessons = db.prepare(
    // Bez imena trenera – kao i kod članova.
    `SELECT l.*, u.name AS member_name FROM lessons l
       JOIN users u ON u.id = l.user_id
       JOIN parent_account_players p ON p.user_id = l.user_id AND p.parent_account_id = ?
      WHERE l.date BETWEEN ? AND ?
      ORDER BY l.date, l.start_time, u.name COLLATE NOCASE`
  );

  // Zajednički sedmični raspored svih dodijeljenih igrača (samo objavljene sedmice).
  router.get('/', (req, res) => {
    const today = D.todayISO();
    const requested = D.isValidDate(req.query.woche) ? req.query.woche : today;
    const monday = D.mondayOf(requested);
    const players = myPlayers.all(req.user.id);
    const released = isWeekReleased(db, monday);
    const lessons = released ? playerLessons.all(req.user.id, monday, D.addDays(monday, 6)) : [];
    const minutes = lessons.filter((l) => !l.cancelled).reduce((s, l) => s + l.duration_min, 0);
    if (released) recordView(db, { kind: 'raspored', period: monday, viewerType: 'roditelj', viewerId: req.user.id, playerIds: players.map((p) => p.id) });

    const { t, lang } = req;
    res.send(String(layout(req, {
      title: t('nav.weekly'),
      wide: true,
      body: html`
      <div class="page-head">
        <div>
          <h1>${t('hello', { name: req.user.name })}</h1>
          <p class="muted">${t('p.weekCount', { n: lessons.filter((l) => !l.cancelled).length, hours: formatHours(minutes / 60, lang) })}
            · ${t('p.players', { names: players.length ? players.map((p) => p.name).join(', ') : '–' })}</p>
        </div>
      </div>
      ${released ? '' : html`<p class="notice">${t('week.notPublished')}</p>`}
      ${weekView({ monday, lessons, baseUrl: '/roditelj', today, lang, holidays: released ? holidaysBetween(db, monday, D.addDays(monday, 6)) : new Map() })}`,
    })));
  });

  // Mjesečni iznosi: igrač(i) po izboru, zbir se računa uživo za odabrani mjesec.
  router.get('/finansije', (req, res) => {
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const players = myPlayers.all(req.user.id);
    const allowed = new Set(players.map((p) => p.id));
    let selected;
    if (req.query.izbor === '1') {
      const raw = [].concat(req.query.igraci || []);
      // Samo dodijeljeni igrači – tuđi ID-jevi se ignorišu.
      selected = new Set(raw.map(Number).filter((id) => allowed.has(id)));
    } else {
      selected = new Set(allowed);
    }
    const rows = players.map((p) => ({ player: p, st: monthlyStatement(db, p, month), on: selected.has(p.id) }));
    // „Ko je pogledao“: igrači čiji je iznos za mjesec odobren (vidljiv u tabeli).
    recordView(db, { kind: 'iznosi', period: month, viewerType: 'roditelj', viewerId: req.user.id, playerIds: rows.filter((r) => r.st.released).map((r) => r.player.id) });
    // Pojedinačne stavke kao kod člana: termini iz još neobjavljenih sedmica se ne navode pojedinačno.
    const detail = (st) => {
      const cache = new Map();
      const shown = st.lessons.filter((l) => {
        const monday = D.mondayOf(l.date);
        if (!cache.has(monday)) cache.set(monday, isWeekReleased(db, monday));
        return cache.get(monday);
      });
      return { ...st, lessons: shown, unpublishedCount: st.lessons.length - shown.length };
    };
    // Član vidi iznos tek kad ga škola odobri – isto važi i za roditeljski račun.
    const counted = rows.filter((r) => r.on && r.st.released);
    const total = counted.reduce((s, r) => s + r.st.total, 0);
    const pendingSelected = rows.filter((r) => r.on && !r.st.released);
    const selectionQuery = `&izbor=1${[...selected].map((id) => `&igraci=${id}`).join('')}`;
    const { t, lang } = req;

    res.send(String(layout(req, {
      title: t('nav.finances'),
      body: html`
      <div class="page-head"><div>
        <h1>${t('nav.finances')}</h1>
        <p class="muted">${t('p.finIntro')}</p>
      </div></div>
      ${monthNav('/roditelj/finansije', month, selectionQuery, { lang })}
      <div class="summary-tile big">
        <span class="label">${t('p.totalSelected', { month: D.monthLabel(month, lang) })}</span>
        <span class="value" data-total="${total}">${formatMoney(total)}</span>
        <span class="hint">${selected.size === 0
          ? t('p.noneSelected')
          : t('p.selected', { n: counted.length + pendingSelected.length, total: players.length })}${
          pendingSelected.length ? t('p.pendingCount', { n: pendingSelected.length }) : ''}</span>
      </div>
      <section class="card">
        <form method="get" action="/roditelj/finansije" class="stack" data-autosubmit>
          <input type="hidden" name="monat" value="${month}">
          <input type="hidden" name="izbor" value="1">
          <div class="table-wrap"><table>
            <thead><tr><th>${t('p.include')}</th><th>${t('p.player')}</th><th class="num">${t('p.sessions')}</th><th class="num">${t('field.amount')}</th><th>${t('field.status')}</th></tr></thead>
            <tbody>${players.length === 0
              ? html`<tr><td colspan="5" class="empty">${t('p.noPlayers')}</td></tr>`
              : rows.map(({ player, st, on }) => html`<tr class="${on ? 'is-selected' : ''}">
                <td><label class="check"><input type="checkbox" name="igraci" value="${player.id}"${on ? ' checked' : ''}><span class="sr-only">${t('p.includeName', { name: player.name })}</span></label></td>
                <td><strong>${player.name}</strong></td>
                <td class="num">${st.manual ? '–' : st.lessonCount}</td>
                <td class="num">${st.released ? formatMoney(st.total) : '–'}</td>
                <td>${st.released ? paymentBadge(st, { lang }) : html`<span class="tag tag-pending">${t('st.pending')}</span>`}</td>
              </tr>`)}</tbody>
          </table></div>
          <div class="btn-row"><button class="btn btn-primary btn-sm" type="submit">${t('p.calc')}</button></div>
        </form>
      </section>
      ${rows.filter((r) => r.on).map(({ player, st }) => html`
      <section class="card player-statement" data-player="${player.id}">
        <h2>${player.name} · ${D.monthLabel(month, lang)}</h2>
        ${st.released
          ? html`<p class="muted small">${st.manual ? '' : `${t('st.termsHours', { n: st.lessonCount, hours: formatHours(st.hours, lang) })} · `}${paymentBadge(st, { lang })}</p>
            ${statementTable(detail(st), { lang })}`
          : html`<p class="notice">${t('p.pendingNotice')}</p>`}
      </section>`)}
      ${selected.size ? html`<div class="summary-tile">
        <span class="label">${t('p.totalSelected', { month: D.monthLabel(month, lang) })}</span>
        <span class="value" data-grand-total="${total}">${formatMoney(total)}</span>
        <span class="hint">${counted.map((r) => `${r.player.name}: ${formatMoney(r.st.total)}`).join(' · ') || '–'}</span>
      </div>` : ''}
      <p class="muted small">${t('p.note')}</p>`,
    })));
  });

  return router;
};
