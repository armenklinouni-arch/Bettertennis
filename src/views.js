'use strict';

const { html } = require('./html');
const D = require('./dates');
const { formatMoney } = require('./money');
const { formatHours } = require('./billing');

const SITE_NAME = 'BetterTennis';

function layout(req, { title, body, wide = false }) {
  const user = req.user;
  const flash = req.takeFlash();
  const path = req.path;
  const navLink = (href, label, exact = false) => {
    const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
    return html`<a href="${href}"${active ? html` class="active" aria-current="page"` : ''}>${label}</a>`;
  };

  let nav;
  if (!user) {
    nav = html`${navLink('/', 'Početna', true)} ${navLink('/login', 'Prijava za članove')}`;
  } else if (user.role === 'admin') {
    nav = html`
      ${navLink('/admin', 'Pregled', true)}
      ${navLink('/admin/interessenten', 'Zainteresovani')}
      ${navLink('/admin/mitglieder', 'Članovi')}
      ${navLink('/admin/grupe', 'Grupe')}
      ${navLink('/admin/treneri', 'Treneri')}
      ${navLink('/admin/termine', 'Termini')}
      ${navLink('/admin/abrechnung', 'Iznosi')}
      ${navLink('/admin/aktuelnosti', 'Aktuelnosti')}`;
  } else if (user.role === 'trainer') {
    nav = html`
      ${navLink('/trener', 'Moj izvještaj', true)}
      ${navLink('/trener/raspored', 'Moj raspored')}
      ${navLink('/trener/lozinka', 'Lozinka')}`;
  } else {
    nav = html`
      ${navLink('/mitglied', 'Sedmični raspored', true)}
      ${navLink('/mitglied/abrechnung', 'Mjesečni iznos')}
      ${navLink('/mitglied/aktuelnosti', html`Aktuelnosti${req.unreadNews ? html` <span class="count" aria-label="nepročitano">${req.unreadNews}</span>` : ''}`)}
      ${navLink('/mitglied/passwort', 'Lozinka')}`;
  }

  return html`<!doctype html>
<html lang="bs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title ? `${title} · ${SITE_NAME}` : SITE_NAME}</title>
  <link rel="stylesheet" href="/static/style.css">
  <script src="/static/app.js" defer></script>
  <link rel="icon" type="image/png" href="/static/img/favicon.png">
  <link rel="apple-touch-icon" href="/static/img/logo-mark.png">
  <meta name="theme-color" content="#11304c">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner${wide || (user && user.role === 'admin') ? ' wide' : ''}">
      <a class="brand" href="${user ? ({ admin: '/admin', trainer: '/trener' }[user.role] || '/mitglied') : '/'}">
        <img class="brand-mark" src="/static/img/logo-mark.png" alt="" width="40" height="40">
        <span class="brand-name">Better<span>Tennis</span></span>
      </a>
      <nav class="main-nav" aria-label="Glavna navigacija">${nav}</nav>
      ${user
        ? html`<form method="post" action="/logout" class="logout">
            ${csrfField(req)}
            <span class="who">${user.name}${user.role === 'admin' ? html` <span class="badge">Admin</span>` : ''}${user.role === 'trainer' ? html` <span class="badge">Trener</span>` : ''}</span>
            <button type="submit" class="btn btn-ghost btn-sm">Odjava</button>
          </form>`
        : ''}
    </div>
  </header>
  <main class="container${wide ? ' wide' : ''}">
    ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.message}</div>` : ''}
    ${body}
  </main>
  <footer class="site-footer">
    <div class="container${wide ? ' wide' : ''}">© ${new Date().getFullYear()} ${SITE_NAME} · Teniska škola</div>
  </footer>
</body>
</html>`;
}

function csrfField(req) {
  return html`<input type="hidden" name="_csrf" value="${req.session.csrf}">`;
}

function errorList(errors) {
  if (!errors || errors.length === 0) return '';
  return html`<div class="flash flash-error" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`;
}

// Vrste treninga i status termina (u bazi: kind i cancelled).
const LESSON_KINDS = { individual: 'Individualni trening', group: 'Grupni trening' };
const LESSON_STATUSES = { done: 'Realizovan', cancelled: 'Otkazan' };

function lessonKindLabel(lesson) {
  return LESSON_KINDS[lesson.kind] || LESSON_KINDS.individual;
}

function lessonStatusLabel(lesson) {
  return lesson.cancelled ? LESSON_STATUSES.cancelled : LESSON_STATUSES.done;
}

function lessonTags(lesson) {
  return html`<div class="lesson-tags">
    <span class="tag tag-kind${lesson.kind === 'group' ? ' is-group' : ''}">${lessonKindLabel(lesson)}</span>
    <span class="tag ${lesson.cancelled ? 'tag-cancelled' : 'tag-done'}">${lessonStatusLabel(lesson)}</span>
  </div>`;
}

function lessonTimeRange(lesson) {
  return `${lesson.start_time}–${D.addMinutes(lesson.start_time, lesson.duration_min)}`;
}

// Sedmični pregled od ponedjeljka do nedjelje.
// lessons: termini (s poljem member_name) unutar sedmice.
// options.baseUrl: cilj za navigaciju po sedmicama; options.actions: funkcija koja vraća dugmad za termin (admin).
function weekView({ monday, lessons, baseUrl, today = D.todayISO(), actions, showPrice = false, extraQuery = '' }) {
  const days = D.weekDays(monday);
  const sunday = days[6];
  const prev = D.addDays(monday, -7);
  const next = D.addDays(monday, 7);
  const thisMonday = D.mondayOf(today);
  const q = (w) => `${baseUrl}?woche=${w}${extraQuery}`;
  const byDay = new Map(days.map((d) => [d, []]));
  for (const l of lessons) if (byDay.has(l.date)) byDay.get(l.date).push(l);

  return html`
  <section class="week" aria-label="Sedmični pregled">
    <div class="week-head">
      <a class="btn btn-ghost btn-sm" href="${q(prev)}" aria-label="Prethodna sedmica">‹ Prethodna</a>
      <div class="week-title">
        <strong>${D.isoWeekNumber(monday)}. sedmica</strong>
        <span>${D.formatDate(monday)} – ${D.formatDate(sunday)}</span>
        ${monday !== thisMonday ? html`<a href="${q(thisMonday)}" class="today-link">Ova sedmica</a>` : ''}
      </div>
      <a class="btn btn-ghost btn-sm" href="${q(next)}" aria-label="Sljedeća sedmica">Sljedeća ›</a>
    </div>
    <div class="week-grid">
      ${days.map((day, i) => {
        const items = byDay.get(day);
        return html`
        <div class="day${day === today ? ' is-today' : ''}${i >= 5 ? ' is-weekend' : ''}">
          <div class="day-head">
            <span class="day-name">${D.DAY_NAMES[i]}</span>
            <span class="day-date">${D.formatDate(day)}</span>
          </div>
          <div class="day-body">
            ${items.length === 0
              ? html`<p class="empty">Nema treninga</p>`
              : items.map(
                  (l) => html`
              <article class="lesson${l.cancelled ? ' is-cancelled' : ''}">
                <div class="lesson-time">${lessonTimeRange(l)} h</div>
                <div class="lesson-name">${l.member_name}</div>
                ${l.trainer_name ? html`<div class="lesson-meta">Trener: ${l.trainer_name}</div>` : ''}
                <div class="lesson-meta">
                  ${D.formatDateLong(l.date)}${l.court ? html` · Teren ${l.court}` : ''}
                </div>
                ${lessonTags(l)}
                ${l.note ? html`<div class="lesson-note">${l.note}</div>` : ''}
                ${showPrice ? html`<div class="lesson-meta">${formatMoney(l.price_cents)}${l.kind === 'group' ? ' po osobi' : ''}</div>` : ''}
                ${actions ? actions(l) : ''}
              </article>`
                )}
          </div>
        </div>`;
      })}
    </div>
  </section>`;
}

// Mjesečni obračun kao tabela (samo informativno).
function statementTable(statement, { adminDelete, req } = {}) {
  const rows = [];
  if (statement.fee) {
    rows.push(html`<tr><td>Mjesečna osnovna članarina</td><td></td><td class="num">${formatMoney(statement.fee)}</td>${adminDelete ? html`<td></td>` : ''}</tr>`);
  }
  for (const l of statement.lessons) {
    rows.push(html`
      <tr class="${l.cancelled ? 'is-cancelled' : ''}">
        <td>${lessonKindLabel(l)} ${D.formatDateLong(l.date)}, ${lessonTimeRange(l)} h${l.court ? ` · Teren ${l.court}` : ''}</td>
        <td>${lessonStatusLabel(l)} · ${l.duration_min} min</td>
        <td class="num">${!statement.billLessons ? '–' : l.cancelled ? formatMoney(0) : formatMoney(l.price_cents)}</td>
        ${adminDelete ? html`<td></td>` : ''}
      </tr>`);
  }
  for (const a of statement.adjustments) {
    rows.push(html`
      <tr>
        <td>${a.description}</td>
        <td>${a.amount_cents < 0 ? 'Odobrenje' : 'Dodatna stavka'}</td>
        <td class="num">${formatMoney(a.amount_cents)}</td>
        ${adminDelete
          ? html`<td class="num">
              <form method="post" action="/admin/posten/${a.id}/loeschen" data-confirm="Zaista obrisati stavku?">
                ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
              </form></td>`
          : ''}
      </tr>`);
  }
  if (rows.length === 0) {
    rows.push(html`<tr><td colspan="${adminDelete ? 4 : 3}" class="empty">Za ovaj mjesec nema stavki.</td></tr>`);
  }

  return html`
  <div class="table-wrap">
    <table class="statement">
      <thead><tr><th>Stavka</th><th>Detalji</th><th class="num">Iznos</th>${adminDelete ? html`<th></th>` : ''}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        ${statement.mode === 'manual'
          ? html`<tr><td>Treninzi</td><td>Ručni obračun – vidi stavke</td><td class="num"></td>${adminDelete ? html`<td></td>` : ''}</tr>`
          : statement.mode === 'display'
            ? html`<tr><td>Realizovani treninzi</td><td>Termini: ${statement.lessonCount} · ${formatHours(statement.hours)} · samo prikaz, bez obračuna</td><td class="num">–</td>${adminDelete ? html`<td></td>` : ''}</tr>`
            : html`<tr><td>Realizovani treninzi</td><td>Termini: ${statement.lessonCount} · ${formatHours(statement.hours)}</td><td class="num">${formatMoney(statement.lessonsTotal)}</td>${adminDelete ? html`<td></td>` : ''}</tr>`}
        <tr class="total"><td>Ukupno ${D.monthLabel(statement.month)}</td><td></td><td class="num">${formatMoney(statement.total)}</td>${adminDelete ? html`<td></td>` : ''}</tr>
      </tfoot>
    </table>
  </div>`;
}

// Da li član vidi obračun za mjesec (odobrio admin) ili je još u pripremi.
function releaseBadge(statement) {
  return statement.released
    ? html`<span class="tag tag-done">Odobreno za člana</span>`
    : html`<span class="tag tag-pending">U pripremi</span>`;
}

// Plaćeno / nije plaćeno – samo informativno.
function paymentBadge(statement) {
  if (!statement.paid && statement.total === 0) return html`<span class="tag">Nema obaveze</span>`;
  return statement.paid
    ? html`<span class="tag tag-done">Plaćeno${statement.paidAt ? ` (${D.formatDate(statement.paidAt)})` : ''}</span>`
    : html`<span class="tag tag-cancelled">Nije plaćeno</span>`;
}

// options.min / options.max (YYYY-MM) ograničavaju navigaciju (npr. članovi vide samo 3 mjeseca unazad).
function monthNav(baseUrl, month, extraQuery = '', { min = null, max = null } = {}) {
  const prev = D.addMonths(month, -1);
  const next = D.addMonths(month, 1);
  return html`
  <div class="month-nav">
    ${min && prev < min
      ? html`<span></span>`
      : html`<a class="btn btn-ghost btn-sm" href="${baseUrl}?monat=${prev}${extraQuery}">‹ ${D.monthLabel(prev)}</a>`}
    <strong>${D.monthLabel(month)}</strong>
    ${max && next > max
      ? html`<span></span>`
      : html`<a class="btn btn-ghost btn-sm" href="${baseUrl}?monat=${next}${extraQuery}">${D.monthLabel(next)} ›</a>`}
  </div>`;
}

module.exports = {
  layout, csrfField, errorList, weekView, statementTable, monthNav, paymentBadge, releaseBadge, lessonTimeRange, lessonTags,
  lessonKindLabel, lessonStatusLabel, LESSON_KINDS, LESSON_STATUSES, SITE_NAME,
};
