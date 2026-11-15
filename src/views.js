'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { html } = require('./html');
const D = require('./dates');
const { sortByName } = require('./search');
const { formatMoney, centsToInput, CURRENCY_SYMBOL } = require('./money');
const { formatHours } = require('./billing');
const { zonedTimeToUtc } = require('./weeks');
const { t: translate } = require('./i18n');

const SITE_NAME = 'BetterTennis';

// Verzija CSS/JS fajlova (hash sadržaja): nakon svake izmjene preglednik učitava novu verziju
// umjesto stare iz keša.
const ASSET_VERSION = (() => {
  const hash = crypto.createHash('sha1');
  for (const f of ['style.css', 'app.js']) hash.update(fs.readFileSync(path.join(__dirname, '..', 'public', f)));
  return hash.digest('hex').slice(0, 10);
})();

// Verzija grafika maskote (hash sadržaja): nakon izmjene preglednik ne prikazuje staru verziju iz keša.
const MASCOT_DIR = path.join(__dirname, '..', 'public', 'img', 'maskota-v2');
const MASCOT_VERSION = (() => {
  const hash = crypto.createHash('sha1');
  for (const f of fs.readdirSync(MASCOT_DIR).filter((x) => x.endsWith('.svg')).sort()) hash.update(fs.readFileSync(path.join(MASCOT_DIR, f)));
  return hash.digest('hex').slice(0, 10);
})();
// Maskota (test): samo za admina, dolje desno – novi dizajn (kapa „BT“, public/img/maskota-v2).
// Trajanje animacija u ms (vidi scripts/maskota-animacije.js).
const MASCOT_ANIMS = { servis: 3000, forhend: 2600, promasaj: 4000, poen: 3200, pogodjen: 3600, mevsme: 7600 };
function mascotWidget(req, t) {
  return html`<div class="mascot-widget" data-mascot data-anims="${JSON.stringify(MASCOT_ANIMS)}" data-version="${MASCOT_VERSION}"><img class="mascot-img" src="/static/img/maskota-v2/spremni.svg?v=${MASCOT_VERSION}" alt="" width="380" height="360"><button type="button" class="mascot-hit" aria-label="${t('mascot.play')}"></button><form method="post" action="/maskota/sakrij" class="mascot-close-form">${csrfField(req)}<button type="submit" class="mascot-close" aria-label="${t('mascot.hide')}">×</button></form></div>`;
}

// Umschalter „BS | EN“ (posjetioci i svi računi osim admina). Nakon izbora nazad na istu stranicu.
function langSwitch(req, lang, t) {
  const home = req.user ? ({ trainer: '/trener', parent: '/roditelj' }[req.user.role] || '/mitglied') : '/';
  const back = req.method === 'GET' ? req.originalUrl : home;
  const button = (code, label) => html`<button type="submit" name="lang" value="${code}"${lang === code ? html` class="is-active" aria-pressed="true"` : html` aria-pressed="false"`}>${label}</button>`;
  return html`<form method="post" action="/jezik" class="lang-switch" aria-label="${t('lang.label')}">
        ${csrfField(req)}<input type="hidden" name="back" value="${back}">
        ${button('bs', 'BS')}
        <span aria-hidden="true">|</span>
        ${button('en', 'EN')}
      </form>`;
}

function layout(req, { title, body, wide = false, fullBleed = false }) {
  const user = req.user;
  // Admin dio je uvijek na bosanskom (req.lang = 'bs'); ostali vide izabrani jezik.
  const lang = req.lang || 'bs';
  const t = (key, vars) => translate(lang, key, vars);
  // Maskota: svi prijavljeni računi (admin, član, dijete, roditelj, trener), osim ako su je sakrili; posjetioci ne.
  const showMascot = !!user && !req.mascotHidden;
  const flash = req.takeFlash();
  const path = req.path;
  const navLink = (href, label, exact = false) => {
    const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
    return html`<a href="${href}"${active ? html` class="active" aria-current="page"` : ''}>${label}</a>`;
  };

  let nav;
  if (!user) {
    nav = req.app.locals.publicHomepage
      ? html`${navLink('/', t('nav.home'), true)} ${navLink('/login', t('nav.memberLogin'))}`
      : html`${navLink('/login', t('nav.memberLogin'))}`;
  } else if (user.role === 'admin') {
    nav = html`
      ${navLink('/admin', 'Pregled', true)}
      ${navLink('/admin/interessenten', 'Zainteresovani')}
      ${navLink('/admin/mitglieder', 'Članovi')}
      ${navLink('/admin/grupe', 'Grupe')}
      ${navLink('/admin/treneri', 'Treneri')}
      ${navLink('/admin/roditelji', 'Roditelji')}
      ${navLink('/admin/termine', 'Termini')}
      ${navLink('/admin/draftovi', 'Sedmični draft')}
      ${navLink('/admin/treninzi-po-igracu', 'Treninzi po igraču')}
      ${navLink('/admin/privatni-casovi', 'Privatni časovi')}
      ${navLink('/admin/abrechnung', 'Iznosi')}
      ${navLink('/admin/finansije', 'Finansije')}
      ${navLink('/admin/aktuelnosti', 'Aktuelnosti')}
      ${navLink('/admin/dnevnik', 'Dnevnik aktivnosti')}
      ${navLink('/admin/ko-je-pogledao', 'Ko je pogledao')}`;
  } else if (user.role === 'trainer') {
    nav = html`
      ${navLink('/trener', t('nav.myReport'), true)}
      ${navLink('/trener/raspored', t('nav.mySchedule'))}
      ${navLink('/trener/lozinka', t('nav.password'))}`;
  } else if (user.role === 'parent') {
    // Roditeljski račun: samo pregled (raspored i finansije dodijeljenih igrača).
    nav = html`
      ${navLink('/roditelj', t('nav.weekly'), true)}
      ${navLink('/roditelj/finansije', t('nav.finances'))}`;
  } else if (user.parent_id) {
    // Dječiji račun: samo sedmični raspored (bez iznosa, plaćanja i obračuna).
    nav = html`${navLink('/mitglied', t('nav.mySchedule'), true)}`;
  } else {
    nav = html`
      ${navLink('/mitglied', t('nav.weekly'), true)}
      ${navLink('/mitglied/abrechnung', t('nav.monthly'))}
      ${navLink('/mitglied/privatni-cas', t('nav.privateLesson'))}
      ${navLink('/mitglied/aktuelnosti', html`${t('nav.news')}${req.unreadNews ? html` <span class="count" aria-label="${t('nav.unread')}">${req.unreadNews}</span>` : ''}`)}
      ${navLink('/mitglied/djeca', t('nav.children'))}
      ${navLink('/mitglied/moji-podaci', t('nav.myData'))}
      ${navLink('/mitglied/passwort', t('nav.password'))}`;
  }

  return html`<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title ? `${title} · ${SITE_NAME}` : SITE_NAME}</title>
  <link rel="stylesheet" href="/static/style.css?v=${ASSET_VERSION}">
  <script src="/static/app.js?v=${ASSET_VERSION}" defer></script>
  <link rel="icon" type="image/png" href="/static/img/favicon.png">
  <link rel="apple-touch-icon" href="/static/img/logo-mark.png">
  <meta name="theme-color" content="#11304c">
</head>
<body${showMascot ? html` class="has-mascot"` : ''}>
  <header class="site-header">
    <div class="container header-inner${wide || (user && user.role === 'admin') ? ' wide' : ''}">
      <a class="brand" href="${user ? ({ admin: '/admin', trainer: '/trener', parent: '/roditelj' }[user.role] || '/mitglied') : '/'}">
        <img class="brand-mark" src="/static/img/logo-mark.png" alt="" width="40" height="40">
        <span class="brand-name">Better<span>Tennis</span></span>
      </a>
      <nav class="main-nav" aria-label="${t('nav.main')}">${nav}</nav>
      ${user && user.role === 'admin' ? '' : langSwitch(req, lang, t)}
      ${user
        ? html`<form method="post" action="/logout" class="logout">
            ${csrfField(req)}
            <span class="who">${user.name}${user.role === 'admin' ? html` <span class="badge">Admin</span>` : ''}${user.role === 'trainer' ? html` <span class="badge">${t('badge.trainer')}</span>` : ''}${user.role === 'parent' ? html` <span class="badge">${t('badge.parent')}</span>` : ''}</span>
            <button type="submit" class="btn btn-ghost btn-sm">${t('logout')}</button>
          </form>`
        : ''}
    </div>
  </header>
  ${fullBleed
    ? html`<main class="main-full">
    ${flash ? html`<div class="container"><div class="flash flash-${flash.type}" role="status">${flash.message}</div></div>` : ''}
    ${body}
  </main>`
    : html`<main class="container${wide ? ' wide' : ''}">
    ${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.message}</div>` : ''}
    ${body}
  </main>`}
  <footer class="site-footer">
    <div class="container${wide ? ' wide' : ''}">© ${new Date().getFullYear()} ${SITE_NAME} · ${t('site.tagline')}${user && req.mascotHidden
      ? html`<form method="post" action="/maskota/prikazi" class="mascot-show-form">${csrfField(req)}<button type="submit" class="link-btn">${t('mascot.show')}</button></form>` : ''}</div>
  </footer>
  ${showMascot ? mascotWidget(req, t) : ''}
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
// U bazi postoje samo „nije otkazan“ (done) i „otkazan“. Prikaz: dok kraj termina (sarajevsko vrijeme)
// nije prošao, termin je „Planiran“, poslije toga automatski „Realizovan“. Obračun se time ne mijenja.
const LESSON_STATUSES = { done: 'Realizovan', cancelled: 'Otkazan' };
const LESSON_PLANNED = 'Planiran';
const LESSON_TIME_ZONE = 'Europe/Sarajevo';

function lessonEndMs(lesson) {
  const [h, m] = String(lesson.start_time).split(':').map(Number);
  return zonedTimeToUtc(lesson.date, h, LESSON_TIME_ZONE, m) + (Number(lesson.duration_min) || 0) * 60000;
}

function isLessonOver(lesson, now = Date.now()) {
  if (!D.isValidDate(lesson.date) || !/^\d{2}:\d{2}$/.test(String(lesson.start_time))) return true;
  return lessonEndMs(lesson) <= now;
}

// Naziv za termin koji nije otkazan: „Planiran“ ili „Realizovan“ (lang: jezik prikaza, standard bosanski).
function activeStatusLabel(lesson, now = Date.now(), lang = 'bs') {
  return translate(lang, isLessonOver(lesson, now) ? 'lesson.done' : 'lesson.planned');
}

function lessonKindLabel(lesson, lang = 'bs') {
  return translate(lang, lesson.kind === 'group' ? 'lesson.group' : 'lesson.individual');
}

function lessonStatusLabel(lesson, lang = 'bs') {
  return lesson.cancelled ? translate(lang, 'lesson.cancelled') : activeStatusLabel(lesson, Date.now(), lang);
}

function lessonTags(lesson, lang = 'bs') {
  return html`<div class="lesson-tags">
    <span class="tag tag-kind${lesson.kind === 'group' ? ' is-group' : ''}">${lessonKindLabel(lesson, lang)}</span>
    <span class="tag ${lesson.cancelled ? 'tag-cancelled' : isLessonOver(lesson) ? 'tag-done' : 'tag-planned'}">${lessonStatusLabel(lesson, lang)}</span>
  </div>`;
}

function lessonTimeRange(lesson) {
  return `${lesson.start_time}–${D.addMinutes(lesson.start_time, lesson.duration_min)}`;
}

// Sedmični pregled od ponedjeljka do nedjelje.
// lessons: termini (s poljem member_name) unutar sedmice.
// options.baseUrl: cilj za navigaciju po sedmicama; options.actions: funkcija koja vraća dugmad za termin (admin).
// Svaki termin je obojena kartica (grupni/individualni/otkazan), svaki igrač u svom redu (member_names ili member_name);
// names_note: kratka napomena ispod imena (npr. „3 igrača“ kod trenera).
// options.numbered (samo admin, Termini): redni broj ispred svakog igrača (1., 2., … – za svaki termin ispočetka).
// options.weekTone (samo admin, Termini): pozadina po sedmici (parna = plava, neparna = zelena) i dugme „Ova sedmica“ uvijek vidljivo.
// options.lang: jezik prikaza (standard bosanski; admin uvijek bosanski).
function weekView({ monday, lessons, baseUrl, today = D.todayISO(), actions, showPrice = false, extraQuery = '', numbered = false, weekTone = false, lang = 'bs' }) {
  const t = (key, vars) => translate(lang, key, vars);
  const dayNames = D.dayNames(lang);
  const days = D.weekDays(monday);
  const sunday = days[6];
  const prev = D.addDays(monday, -7);
  const next = D.addDays(monday, 7);
  const thisMonday = D.mondayOf(today);
  const q = (w) => `${baseUrl}?woche=${w}${extraQuery}`;
  const byDay = new Map(days.map((d) => [d, []]));
  for (const l of lessons) if (byDay.has(l.date)) byDay.get(l.date).push(l);

  const weekNo = D.isoWeekNumber(monday);
  const blue = weekNo % 2 === 0;
  return html`
  <section class="${weekTone ? `week week-tone ${blue ? 'is-blue' : 'is-green'}` : 'week'}" aria-label="${t('week.aria')}">
    <div class="week-head">
      <a class="btn btn-ghost btn-sm" href="${q(prev)}" aria-label="${t('week.prevAria')}">${t('week.prev')}</a>
      <div class="week-title">
        ${weekTone
          ? html`<strong>${t('week.number', { n: weekNo })} <small class="week-tone-label">${blue ? 'plava sedmica' : 'zelena sedmica'}</small></strong>`
          : html`<strong>${t('week.number', { n: weekNo })}</strong>`}
        <span>${D.formatDate(monday, lang)} – ${D.formatDate(sunday, lang)}</span>
        ${weekTone
          ? html`<a class="btn btn-ghost btn-sm week-today-btn" href="${q(thisMonday)}">${t('week.thisWeek')}</a>`
          : monday !== thisMonday ? html`<a href="${q(thisMonday)}" class="today-link">${t('week.thisWeek')}</a>` : ''}
      </div>
      <a class="btn btn-ghost btn-sm" href="${q(next)}" aria-label="${t('week.nextAria')}">${t('week.next')}</a>
    </div>
    <div class="week-grid">
      ${days.map((day, i) => {
        const items = byDay.get(day);
        return html`
        <div class="day${day === today ? ' is-today' : ''}${i >= 5 ? ' is-weekend' : ''}">
          <div class="day-head">
            <span class="day-name">${dayNames[i]}</span>
            <span class="day-date">${D.formatDate(day, lang)}</span>
          </div>
          <div class="day-body">
            ${items.length === 0
              ? html`<p class="empty">${t('week.noTraining')}</p>`
              : items.map(
                  (l) => html`
              <article class="lesson lesson-card ${l.kind === 'group' ? 'is-group' : 'is-individual'}${l.cancelled ? ' is-cancelled' : ''}">
                <div class="lesson-time">${lessonTimeRange(l)} h</div>
                <ul class="lesson-names">${(l.member_names || [l.member_name]).map((n, i) => html`<li title="${n}">${numbered ? html`<span class="lesson-num">${i + 1}.</span> ` : ''}${n}</li>`)}</ul>
                ${l.names_note ? html`<div class="lesson-meta">${l.names_note}</div>` : ''}
                ${l.trainer_name ? html`<div class="lesson-meta">${t('lesson.trainer', { name: l.trainer_name })}</div>` : ''}
                <div class="lesson-meta">
                  ${D.formatDateLong(l.date, lang)}${l.court ? html` · ${t('lesson.court', { court: l.court })}` : ''}
                </div>
                ${lessonTags(l, lang)}
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

// Prisustvo igrača na terminu – samo dokumentacija za admina; NE utiče na obračun.
const ATTENDANCE = {
  present: 'prisutan',
  no_show: 'nije došao/la',
  sick: 'bolestan/na',
  injured: 'povrijeđen/a',
  cancelled_on_time: 'otkazao/la na vrijeme',
  cancelled_late: 'otkazao/la prekasno',
  other: 'drugi razlog',
};

function attendanceLabel(l) {
  if (!l.attendance || !ATTENDANCE[l.attendance]) return '–';
  return l.attendance === 'other' && l.attendance_note ? `${ATTENDANCE.other}: ${l.attendance_note}` : ATTENDANCE[l.attendance];
}

// Kratki pregled prisustva u mjesecu, npr. „8 prisutan, 1 bolestan/na“ (termini bez statusa se ne broje).
function attendanceSummary(lessons) {
  const counts = new Map();
  for (const l of lessons) if (ATTENDANCE[l.attendance]) counts.set(l.attendance, (counts.get(l.attendance) || 0) + 1);
  return Object.keys(ATTENDANCE).filter((k) => counts.has(k)).map((k) => `${counts.get(k)} ${ATTENDANCE[k]}`).join(', ');
}

// Zelena kvačica = u obračunu, siva precrtana = ručno isključeno iz obračuna.
function billingMark(l) {
  return l.billable === 0
    ? html`<span class="bill-mark is-off" title="Nije u obračunu">✓</span>`
    : html`<span class="bill-mark is-on" title="U obračunu">✓</span>`;
}

// Mjesečni obračun kao tabela (samo informativno).
// adjustmentDates: uz stavke prikaži datum unosa (samo admin; članovi i roditelji vide samo „Dodatna stavka“).
// attendance / billingMarks: dodatne kolone samo za admina (status prisustva; kvačica za obračun kod „Prema rasporedu“).
// lessonAmountUrl (samo admin, „Prikaz bez obračuna“): adresa za unos iznosa pojedinog termina.
function statementTable(statement, {
  adminDelete, req, adjustmentDates = false, attendance = false, billingMarks = false, lessonAmountUrl = null,
  // Samo admin: red „Treninzi – Ručni obračun – vidi stavke“ (članovi i roditelji vide samo stavke i Ukupno).
  showManualRow = false,
  // Samo admin: kolona „Detalji“ (članovi i roditelji vide samo „Stavka“ i „Iznos“).
  showDetails = false,
  // Samo admin (otvoren mjesec): „Uredi“ uz stavku; editId = stavka koja se upravo uređuje u svom redu.
  editId = null, editUrl = null, cancelUrl = null,
  // Jezik prikaza (članovi i roditelji); admin uvijek bosanski.
  lang = 'bs',
} = {}) {
  const t = (key, vars) => translate(lang, key, vars);
  const det = (content) => (showDetails ? html`<td>${content}</td>` : '');
  const showStatus = attendance && statement.mode !== 'manual';
  const showMarks = billingMarks && statement.mode === 'schedule';
  const extra = () => html`${showStatus ? html`<td></td>` : ''}${showMarks ? html`<td></td>` : ''}`;
  const del = () => (adminDelete ? html`<td></td>` : '');
  const cols = 2 + (showDetails ? 1 : 0) + (showStatus ? 1 : 0) + (showMarks ? 1 : 0) + (adminDelete ? 1 : 0);
  const rows = [];
  const off = statement.noTraining ? ' is-unbilled' : '';
  if (statement.fee) {
    rows.push(html`<tr class="${off}"><td>${t('st.fee')}</td>${det('')}${extra()}<td class="num">${formatMoney(statement.fee)}</td>${del()}</tr>`);
  }
  const isDisplay = statement.mode === 'display';
  const hasAmount = (l) => l.display_amount_cents !== null && l.display_amount_cents !== undefined;
  for (const l of statement.lessons) {
    const amount = statement.noTraining ? '–' : isDisplay
      ? (hasAmount(l) ? formatMoney(l.display_amount_cents) : '–')
      : !statement.billLessons ? '–' : l.cancelled || l.billable === 0 ? formatMoney(0) : formatMoney(l.price_cents);
    const note = isDisplay && l.display_note ? l.display_note : '';
    rows.push(html`
      <tr${isDisplay ? html` id="termin-${l.id}"` : ''} class="${l.cancelled ? 'is-cancelled' : ''}${showMarks && l.billable === 0 ? ' is-unbilled' : ''}">
        <td>${lessonKindLabel(l, lang)} ${D.formatDateLong(l.date, lang)}, ${lessonTimeRange(l)} h${l.court ? ` · ${t('lesson.court', { court: l.court })}` : ''}${
          note ? html`<br><span class="lesson-note">📝 ${note}</span>` : ''}</td>
        ${det(`${lessonStatusLabel(l)} · ${l.duration_min} min`)}
        ${showStatus ? html`<td class="attendance">${attendanceLabel(l)}</td>` : ''}
        ${showMarks ? html`<td class="billing">${billingMark(l)}</td>` : ''}
        <td class="num">${amount}${isDisplay && lessonAmountUrl ? html` <a class="edit-amount" href="${lessonAmountUrl(l)}">✎ Uredi</a>` : ''}</td>
        ${del()}
      </tr>`);
  }
  for (const a of statement.adjustments) {
    if (adminDelete && editUrl && editId === a.id) {
      rows.push(html`
      <tr id="stavka-${a.id}" class="stavka-edit"><td colspan="${cols}">
        <form class="stavka-edit-form" method="post" action="/admin/posten/${a.id}/uredi">
          ${csrfField(req)}
          <label>Opis<input name="description" required maxlength="200" value="${a.description}" autofocus></label>
          <label>Iznos (${CURRENCY_SYMBOL})<input name="amount" required inputmode="decimal" value="${centsToInput(a.amount_cents)}"></label>
          <div class="stavka-actions"><button class="btn btn-primary btn-sm" type="submit">Spremi</button>
            <a class="btn btn-ghost btn-sm" href="${cancelUrl(a)}">Odustani</a></div>
        </form>
      </td></tr>`);
      continue;
    }
    rows.push(html`
      <tr${adminDelete ? html` id="stavka-${a.id}"` : ''} class="${off}">
        <td>${a.description}</td>
        ${det(`${a.amount_cents < 0 ? 'Odobrenje' : 'Dodatna stavka'}${adjustmentDates && a.created_at ? ` · ${D.formatDate(a.created_at.slice(0, 10))}` : ''}`)}
        ${extra()}
        <td class="num">${formatMoney(a.amount_cents)}</td>
        ${adminDelete
          ? html`<td class="num stavka-actions">${editUrl ? html`<a class="btn btn-ghost btn-sm" href="${editUrl(a)}">Uredi</a> ` : ''}
              <form method="post" action="/admin/posten/${a.id}/loeschen" data-confirm="Zaista obrisati stavku?">
                ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
              </form></td>`
          : ''}
      </tr>`);
  }
  if (statement.unpublishedCount) {
    rows.push(html`
      <tr><td>${t('st.unpublished')}</td>${det(`Termini: ${statement.unpublishedCount}`)}${extra()}<td class="num"></td>${del()}</tr>`);
  }
  if (rows.length === 0) {
    rows.push(html`<tr><td colspan="${cols}" class="empty">${t('st.empty')}</td></tr>`);
  }

  return html`
  <div class="table-wrap">
    <table class="statement">
      <thead><tr><th>${t('st.item')}</th>${showDetails ? html`<th>Detalji</th>` : ''}${showStatus ? html`<th>Status</th>` : ''}${showMarks ? html`<th>Obračun</th>` : ''}<th class="num">${t('field.amount')}</th>${adminDelete ? html`<th></th>` : ''}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot>
        ${statement.noTraining
          ? html`<tr class="no-training"><td>${t('st.noTraining')}</td>${det('Iznos za mjesec: 0 KM')}${extra()}<td class="num">${formatMoney(0)}</td>${del()}</tr>`
          : statement.mode === 'manual'
          ? (showManualRow ? html`<tr><td>Treninzi</td>${det('Ručni obračun – vidi stavke')}${extra()}<td class="num"></td>${del()}</tr>` : '')
          : statement.mode === 'display' && statement.display && statement.display.override !== null
            ? html`<tr><td>${t('st.trainingsOverride')}</td>${det(`Termini: ${statement.lessonCount} · ${formatHours(statement.hours)} · zbir po terminima: ${formatMoney(statement.display.autoTotal)}`)}${extra()}<td class="num">${formatMoney(statement.lessonsTotal)}</td>${del()}</tr>`
          : statement.mode === 'display' && statement.display && statement.display.amounts > 0
            ? html`<tr><td>${t('st.trainingsPerLesson')}</td>${det(`Termini: ${statement.lessonCount} · ${formatHours(statement.hours)}`)}${extra()}<td class="num">${formatMoney(statement.lessonsTotal)}</td>${del()}</tr>`
          : statement.mode === 'display'
            ? html`<tr><td>${t('st.realized')}</td>${det(`Termini: ${statement.lessonCount} · ${formatHours(statement.hours)} · samo prikaz, bez obračuna`)}${extra()}<td class="num">–</td>${del()}</tr>`
            : html`<tr><td>${t('st.realized')}</td>${det(`Termini: ${statement.lessonCount} · ${formatHours(statement.hours)}`)}${extra()}<td class="num">${formatMoney(statement.lessonsTotal)}</td>${del()}</tr>`}
        <tr class="total"><td>${t('st.total', { month: D.monthLabel(statement.month, lang) })}</td>${det('')}${extra()}<td class="num">${formatMoney(statement.total)}</td>${del()}</tr>
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

// Filter i „Odabrano: N“ iznad liste igrača s kvačicama (Termini „Igrači u grupi“, Grupe).
// Polje filtera nema name (ne šalje se) i prikazuje ga tek JavaScript, da Enter ne pošalje obrazac.
function checklistTools({ key, members, selected }) {
  const chosen = sortByName(members.filter((m) => selected.has(String(m.id))));
  return html`
    <div class="checklist-tools" data-checklist-filter>
      <div class="list-filter checklist-filter" hidden>
        <label for="filter-${key}">Filter</label>
        <div class="filter-box">
          <input id="filter-${key}" type="text" inputmode="search" autocomplete="off" spellcheck="false" placeholder="Ime igrača" data-checklist-input>
          <button type="button" class="filter-clear" aria-label="Obriši filter" hidden>×</button>
        </div>
      </div>
      <p class="checklist-selected" aria-live="polite">Odabrano: <strong data-count>${chosen.length}</strong><span data-names>${chosen.length ? `: ${chosen.map((m) => m.name).join(', ')}` : ''}</span></p>
    </div>`;
}

// Polje „Filter“ iznad liste. Bez JavaScripta radi preko ?trazi=…; s JavaScriptom filtrira već pri kucanju.
function listFilter({ key, action, value = '', clearHref, hidden = {} }) {
  return html`
    <form method="get" action="${action}" class="list-filter" role="search" data-list-filter="${key}">
      ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <label for="filter-${key}">Filter</label>
      <div class="filter-box">
        <input id="filter-${key}" name="trazi" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" spellcheck="false" placeholder="Ime ili korisničko ime" value="${value}">
        <a class="filter-clear" href="${clearHref}" aria-label="Obriši filter"${value ? '' : html` hidden`}>×</a>
      </div>
    </form>`;
}

// Plaćeno / nije plaćeno – samo informativno. Datum uplate je interna informacija: prikazuje se samo
// adminu (showDate); članovi i roditeljski računi vide samo „Plaćeno“.
function paymentBadge(statement, { showDate = false, lang = 'bs' } = {}) {
  const t = (key) => translate(lang, key);
  if (statement.noTraining) return html`<span class="tag tag-none">${t('pay.noTraining')}</span>`;
  if (!statement.paid && statement.total === 0) return html`<span class="tag">${t('pay.nothingDue')}</span>`;
  return statement.paid
    ? html`<span class="tag tag-done">${t('pay.paid')}${showDate && statement.paidAt ? ` (${D.formatDate(statement.paidAt)})` : ''}</span>`
    : html`<span class="tag tag-cancelled">${t('pay.unpaid')}</span>`;
}

// options.min / options.max (YYYY-MM) ograničavaju navigaciju (npr. članovi vide samo 3 mjeseca unazad).
function monthNav(baseUrl, month, extraQuery = '', { min = null, max = null, lang = 'bs' } = {}) {
  const prev = D.addMonths(month, -1);
  const next = D.addMonths(month, 1);
  return html`
  <div class="month-nav">
    ${min && prev < min
      ? html`<span></span>`
      : html`<a class="btn btn-ghost btn-sm" href="${baseUrl}?monat=${prev}${extraQuery}" aria-label="${D.monthLabel(prev, lang)}">‹ <span class="month-nav-label">${D.monthLabel(prev, lang)}</span></a>`}
    <strong>${D.monthLabel(month, lang)}</strong>
    ${max && next > max
      ? html`<span></span>`
      : html`<a class="btn btn-ghost btn-sm" href="${baseUrl}?monat=${next}${extraQuery}" aria-label="${D.monthLabel(next, lang)}"><span class="month-nav-label">${D.monthLabel(next, lang)}</span> ›</a>`}
  </div>`;
}

module.exports = {
  layout, csrfField, errorList, weekView, statementTable, monthNav, paymentBadge, releaseBadge, listFilter, checklistTools, lessonTimeRange, lessonTags,
  lessonKindLabel, lessonStatusLabel, activeStatusLabel, isLessonOver, LESSON_KINDS, LESSON_STATUSES, LESSON_PLANNED, SITE_NAME,
  ATTENDANCE, attendanceLabel, attendanceSummary, billingMark,
};
