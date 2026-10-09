'use strict';

const { html } = require('./html');
const D = require('./dates');
const { formatEUR } = require('./money');
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
    nav = html`${navLink('/', 'Start', true)} ${navLink('/login', 'Mitglieder-Login')}`;
  } else if (user.role === 'admin') {
    nav = html`
      ${navLink('/admin', 'Übersicht', true)}
      ${navLink('/admin/interessenten', 'Interessenten')}
      ${navLink('/admin/mitglieder', 'Mitglieder')}
      ${navLink('/admin/termine', 'Termine')}
      ${navLink('/admin/abrechnung', 'Beträge')}`;
  } else {
    nav = html`
      ${navLink('/mitglied', 'Wochenplan', true)}
      ${navLink('/mitglied/abrechnung', 'Monatsbetrag')}
      ${navLink('/mitglied/passwort', 'Passwort')}`;
  }

  return html`<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title ? `${title} · ${SITE_NAME}` : SITE_NAME}</title>
  <link rel="stylesheet" href="/static/style.css">
  <script src="/static/app.js" defer></script>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='44' fill='%23d4e157'/%3E%3Cpath d='M18 26c22 14 22 34 0 48M82 26c-22 14-22 34 0 48' stroke='%23fff' stroke-width='6' fill='none'/%3E%3C/svg%3E">
</head>
<body>
  <header class="site-header">
    <div class="container header-inner${wide ? ' wide' : ''}">
      <a class="brand" href="${user ? (user.role === 'admin' ? '/admin' : '/mitglied') : '/'}">
        <span class="ball" aria-hidden="true"></span>${SITE_NAME}
      </a>
      <nav class="main-nav" aria-label="Hauptnavigation">${nav}</nav>
      ${user
        ? html`<form method="post" action="/logout" class="logout">
            ${csrfField(req)}
            <span class="who">${user.name}${user.role === 'admin' ? html` <span class="badge">Admin</span>` : ''}</span>
            <button type="submit" class="btn btn-ghost btn-sm">Abmelden</button>
          </form>`
        : ''}
    </div>
  </header>
  <main class="container${wide ? ' wide' : ''}">
    ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.message}</div>` : ''}
    ${body}
  </main>
  <footer class="site-footer">
    <div class="container${wide ? ' wide' : ''}">© ${new Date().getFullYear()} ${SITE_NAME} · Tennisschule</div>
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

function lessonTimeRange(lesson) {
  return `${lesson.start_time}–${D.addMinutes(lesson.start_time, lesson.duration_min)}`;
}

// Wochenübersicht Montag bis Sonntag.
// lessons: Termine (mit Feld member_name) innerhalb der Woche.
// options.baseUrl: Ziel für die Wochen-Navigation; options.linkLesson: Funktion für Bearbeiten-Links (Admin).
function weekView({ monday, lessons, baseUrl, today = D.todayISO(), linkLesson, showPrice = false, extraQuery = '' }) {
  const days = D.weekDays(monday);
  const sunday = days[6];
  const prev = D.addDays(monday, -7);
  const next = D.addDays(monday, 7);
  const thisMonday = D.mondayOf(today);
  const q = (w) => `${baseUrl}?woche=${w}${extraQuery}`;
  const byDay = new Map(days.map((d) => [d, []]));
  for (const l of lessons) if (byDay.has(l.date)) byDay.get(l.date).push(l);

  return html`
  <section class="week" aria-label="Wochenübersicht">
    <div class="week-head">
      <a class="btn btn-ghost btn-sm" href="${q(prev)}" aria-label="Vorherige Woche">‹ Vorherige</a>
      <div class="week-title">
        <strong>KW ${D.isoWeekNumber(monday)}</strong>
        <span>${D.formatDate(monday)} – ${D.formatDate(sunday)}</span>
        ${monday !== thisMonday ? html`<a href="${q(thisMonday)}" class="today-link">Diese Woche</a>` : ''}
      </div>
      <a class="btn btn-ghost btn-sm" href="${q(next)}" aria-label="Nächste Woche">Nächste ›</a>
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
              ? html`<p class="empty">Kein Training</p>`
              : items.map(
                  (l) => html`
              <article class="lesson${l.cancelled ? ' is-cancelled' : ''}">
                <div class="lesson-time">${lessonTimeRange(l)} Uhr</div>
                <div class="lesson-name">${l.member_name}</div>
                <div class="lesson-meta">
                  ${D.formatDateLong(l.date)}${l.court ? html` · Platz ${l.court}` : ''}
                </div>
                ${l.cancelled ? html`<div class="lesson-tag">Abgesagt</div>` : ''}
                ${l.note ? html`<div class="lesson-note">${l.note}</div>` : ''}
                ${showPrice ? html`<div class="lesson-meta">${formatEUR(l.price_cents)}</div>` : ''}
                ${linkLesson ? html`<a class="lesson-edit" href="${linkLesson(l)}">Bearbeiten</a>` : ''}
              </article>`
                )}
          </div>
        </div>`;
      })}
    </div>
  </section>`;
}

// Monatsabrechnung als Tabelle (nur Information).
function statementTable(statement, { adminDelete, req } = {}) {
  const rows = [];
  if (statement.fee) {
    rows.push(html`<tr><td>Monatliche Grundgebühr</td><td></td><td class="num">${formatEUR(statement.fee)}</td>${adminDelete ? html`<td></td>` : ''}</tr>`);
  }
  for (const l of statement.lessons) {
    rows.push(html`
      <tr class="${l.cancelled ? 'is-cancelled' : ''}">
        <td>Training ${D.formatDateLong(l.date)}, ${lessonTimeRange(l)} Uhr${l.court ? ` · Platz ${l.court}` : ''}</td>
        <td>${l.cancelled ? 'abgesagt' : `${l.duration_min} Min.`}</td>
        <td class="num">${l.cancelled ? formatEUR(0) : formatEUR(l.price_cents)}</td>
        ${adminDelete ? html`<td></td>` : ''}
      </tr>`);
  }
  for (const a of statement.adjustments) {
    rows.push(html`
      <tr>
        <td>${a.description}</td>
        <td>${a.amount_cents < 0 ? 'Gutschrift' : 'Zusatzposten'}</td>
        <td class="num">${formatEUR(a.amount_cents)}</td>
        ${adminDelete
          ? html`<td class="num">
              <form method="post" action="/admin/posten/${a.id}/loeschen" data-confirm="Posten wirklich löschen?">
                ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Löschen</button>
              </form></td>`
          : ''}
      </tr>`);
  }
  if (rows.length === 0) {
    rows.push(html`<tr><td colspan="${adminDelete ? 4 : 3}" class="empty">Für diesen Monat sind keine Posten vorhanden.</td></tr>`);
  }

  return html`
  <div class="table-wrap">
    <table class="statement">
      <thead><tr><th>Posten</th><th>Details</th><th class="num">Betrag</th>${adminDelete ? html`<th></th>` : ''}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td>Trainingsstunden</td><td>${statement.lessonCount} Termine · ${formatHours(statement.hours)}</td><td class="num">${formatEUR(statement.lessonsTotal)}</td>${adminDelete ? html`<td></td>` : ''}</tr>
        <tr class="total"><td>Summe ${D.monthLabel(statement.month)}</td><td></td><td class="num">${formatEUR(statement.total)}</td>${adminDelete ? html`<td></td>` : ''}</tr>
      </tfoot>
    </table>
  </div>`;
}

function monthNav(baseUrl, month, extraQuery = '') {
  return html`
  <div class="month-nav">
    <a class="btn btn-ghost btn-sm" href="${baseUrl}?monat=${D.addMonths(month, -1)}${extraQuery}">‹ ${D.monthLabel(D.addMonths(month, -1))}</a>
    <strong>${D.monthLabel(month)}</strong>
    <a class="btn btn-ghost btn-sm" href="${baseUrl}?monat=${D.addMonths(month, 1)}${extraQuery}">${D.monthLabel(D.addMonths(month, 1))} ›</a>
  </div>`;
}

module.exports = { layout, csrfField, errorList, weekView, statementTable, monthNav, lessonTimeRange, SITE_NAME };
