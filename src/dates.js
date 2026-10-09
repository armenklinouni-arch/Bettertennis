'use strict';

// Datumslogik arbeitet ausschließlich mit Strings im Format YYYY-MM-DD bzw. YYYY-MM.
// Intern wird UTC verwendet, damit Sommer-/Winterzeit keine Tage verschiebt.

const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const DAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function toDate(iso) {
  const m = ISO_RE.exec(iso || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === iso ? d : null;
}

function isValidDate(iso) {
  return toDate(iso) !== null;
}

function isValidMonth(ym) {
  const m = MONTH_RE.exec(ym || '');
  return !!m && +m[2] >= 1 && +m[2] <= 12;
}

function isValidTime(t) {
  return TIME_RE.test(t || '');
}

function toISO(d) {
  return d.toISOString().slice(0, 10);
}

// Heutiges Datum in der lokalen Zeitzone des Servers (TZ, Standard Europe/Berlin).
function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function addDays(iso, n) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

// 0 = Montag … 6 = Sonntag
function weekdayIndex(iso) {
  return (toDate(iso).getUTCDay() + 6) % 7;
}

function mondayOf(iso) {
  return addDays(iso, -weekdayIndex(iso));
}

function weekDays(mondayIso) {
  return Array.from({ length: 7 }, (_, i) => addDays(mondayIso, i));
}

function isoWeekNumber(iso) {
  const d = toDate(iso);
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((thursday - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function formatDateShort(iso) {
  const [, m, d] = iso.split('-');
  return `${d}.${m}.`;
}

function formatDateLong(iso) {
  return `${DAY_NAMES[weekdayIndex(iso)]}, ${formatDate(iso)}`;
}

function monthOf(iso) {
  return iso.slice(0, 7);
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${ym}-01`, last: `${ym}-${pad(last)}` };
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

module.exports = {
  DAY_NAMES,
  DAY_SHORT,
  isValidDate,
  isValidMonth,
  isValidTime,
  todayISO,
  addDays,
  weekdayIndex,
  mondayOf,
  weekDays,
  isoWeekNumber,
  formatDate,
  formatDateShort,
  formatDateLong,
  monthOf,
  monthRange,
  addMonths,
  monthLabel,
  addMinutes,
};
