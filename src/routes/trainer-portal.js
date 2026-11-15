'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney } = require('../money');
const { formatHours } = require('../billing');
const { trainerReport, trainerSessionsBetween, trainerTotalsUntil } = require('../trainers');
const { layout, csrfField, errorList, weekView, monthNav, lessonTimeRange, lessonKindLabel } = require('../views');
const { requireTrainer, hashPassword, verifyPassword, endSessionsFor } = require('../auth');
const { logActivity } = require('../activity');

// Trenerski dio: svaki trener vidi samo svoje termine, svoje igrače i svoju isplatu.
// Cijene članova i podaci drugih trenera ovdje se nikad ne prikazuju.
module.exports = function trainerPortalRoutes(db) {
  const router = express.Router();
  router.use(requireTrainer);

  // „3 igrača“ / „3 players“ – na jeziku trenera.
  function playersLabel(req, session) {
    return req.t('tr.playerCount', { n: session.members.length });
  }

  // ---------------------------------------------------------------- Mjesečni izvještaj
  router.get('/', (req, res) => {
    const trainer = req.user;
    const today = D.todayISO();
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(today);
    const r = trainerReport(db, trainer, month);
    const total = trainerTotalsUntil(db, trainer, today);
    const totalMinutes = total.individual.minutes + total.group.minutes;
    const totalCount = total.individual.count + total.group.count;
    const { t, lang } = req;
    const hours = (minutes) => formatHours(minutes / 60, lang);

    res.send(String(layout(req, {
      title: t('nav.myReport'),
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>${t('hello', { name: trainer.name })}</h1>
        <p class="muted">${t('tr.intro')}</p>
      </div></div>

      <section class="card">
        <h2>${t('tr.totalToDate')}</h2>
        <div class="tiles">
          <div class="summary-tile"><span class="label">${t('tr.totalHours')}</span><span class="value">${hours(totalMinutes)}</span>
            <span class="hint">${t('tr.sessionsSince', { n: totalCount, since: total.first ? D.formatDate(total.first, lang) : '' })}</span></div>
          <div class="summary-tile"><span class="label">${t('tr.individual')}</span><span class="value">${total.individual.count}</span>
            <span class="hint">${hours(total.individual.minutes)}</span></div>
          <div class="summary-tile"><span class="label">${t('tr.group')}</span><span class="value">${total.group.count}</span>
            <span class="hint">${hours(total.group.minutes)}</span></div>
        </div>
      </section>

      <h2>${t('tr.monthly')}</h2>
      ${monthNav('/trener', month, '', { lang })}
      <div class="tiles">
        <div class="summary-tile"><span class="label">${t('tr.individual')}</span><span class="value">${r.individual.count}</span>
          <span class="hint">${hours(r.individual.minutes)} · ${formatMoney(r.individual.pay)}</span></div>
        <div class="summary-tile"><span class="label">${t('tr.group')}</span><span class="value">${r.group.count}</span>
          <span class="hint">${hours(r.group.minutes)} · ${formatMoney(r.group.pay)}</span></div>
        <div class="summary-tile"><span class="label">${t('tr.extra')}</span><span class="value">${formatMoney(r.bonusTotal)}</span>
          <span class="hint">${r.bonuses.map((b) => b.description).join(', ') || t('tr.none')}</span></div>
        <div class="summary-tile big"><span class="label">${t('tr.monthTotal', { month: D.monthLabel(month, lang) })}</span><span class="value">${formatMoney(r.payTotal)}</span>
          <span class="hint">${t('tr.overall', { hours: hours(r.individual.minutes + r.group.minutes) })}</span></div>
      </div>

      <section class="card">
        <h2>${t('tr.sessionsIn', { n: r.sessions.length })}</h2>
        ${r.sessions.length === 0
          ? html`<p class="muted">${t('tr.noSessions')}</p>`
          : html`<div class="table-wrap"><table>
            <thead><tr><th>${t('tr.date')}</th><th>${t('tr.time')}</th><th>${t('tr.type')}</th><th>${t('tr.players')}</th><th class="num">${t('tr.duration')}</th><th class="num">${t('tr.pay')}</th></tr></thead>
            <tbody>${r.sessions.map((s) => html`
              <tr>
                <td>${D.formatDateLong(s.date, lang)}${s.date > today ? html` <span class="tag">${t('tr.plannedTag')}</span>` : ''}</td>
                <td>${lessonTimeRange(s)} h${s.court ? ` · ${t('lesson.court', { court: s.court })}` : ''}</td>
                <td><span class="tag tag-kind${s.kind === 'group' ? ' is-group' : ''}">${lessonKindLabel(s, lang)}</span></td>
                <td><strong>${playersLabel(req, s)}:</strong> ${s.members.join(', ')}</td>
                <td class="num">${s.duration_min} min</td>
                <td class="num">${formatMoney(s.pay_cents)}</td>
              </tr>`)}</tbody>
            <tfoot><tr class="total"><td colspan="4">${t('tr.trainingTotal')}</td>
              <td class="num">${hours(r.individual.minutes + r.group.minutes)}</td>
              <td class="num">${formatMoney(r.individual.pay + r.group.pay)}</td></tr></tfoot>
          </table></div>`}
        <p class="muted small">${t('tr.note')}</p>
      </section>`,
    })));
  });

  // ---------------------------------------------------------------- Sedmični raspored trenera
  router.get('/raspored', (req, res) => {
    const today = D.todayISO();
    const monday = D.mondayOf(D.isValidDate(req.query.woche) ? req.query.woche : today);
    const sessions = trainerSessionsBetween(db, req.user, monday, D.addDays(monday, 6), { includeCancelled: true });
    const lessons = sessions.map((s) => ({ ...s, member_name: `${s.members.join(', ')} (${playersLabel(req, s)})`, member_names: s.members, names_note: playersLabel(req, s) }));
    res.send(String(layout(req, {
      title: req.t('nav.mySchedule'),
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>${req.t('nav.mySchedule')}</h1>
        <p class="muted">${req.t('tr.scheduleIntro')}</p>
      </div></div>
      ${weekView({ monday, lessons, baseUrl: '/trener/raspored', today, lang: req.lang })}`,
    })));
  });

  // ---------------------------------------------------------------- Lozinka
  function passwordPage(req, errors = []) {
    const { t } = req;
    return layout(req, {
      title: t('pw.title'),
      body: html`
      <section class="card narrow">
        <h1>${t('pw.title')}</h1>
        ${errorList(errors)}
        <form method="post" action="/trener/lozinka" class="stack">
          ${csrfField(req)}
          <label>${t('pw.current')}<input name="current" type="password" required autocomplete="current-password"></label>
          <label>${t('pw.new')}<input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
          <label>${t('pw.repeat')}<input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
          <button class="btn btn-primary" type="submit">${t('btn.save')}</button>
        </form>
      </section>`,
    });
  }

  router.get('/lozinka', (req, res) => {
    res.send(String(passwordPage(req)));
  });

  router.post('/lozinka', (req, res) => {
    const { current = '', password = '', password2 = '' } = req.body;
    const errors = [];
    if (!verifyPassword(current, req.user.password_hash)) errors.push(req.t('pw.currentWrong'));
    if (typeof password !== 'string' || password.length < 8) errors.push(req.t('pw.newMin8'));
    if (password !== password2) errors.push(req.t('pw.newMismatch'));
    if (errors.length) {
      res.status(400);
      return res.send(String(passwordPage(req, errors)));
    }
    db.prepare('UPDATE trainers SET password_hash = ? WHERE id = ?').run(hashPassword(password), req.user.trainer_id);
    logActivity(db, req, 'Treneri', `${req.user.name} – lozinka promijenjena`);
    endSessionsFor(db, 'trainer', req.user.trainer_id, { keep: req.session.sid });
    res.flash('success', req.t('pw.changed'));
    res.redirect('/trener');
  });

  return router;
};
