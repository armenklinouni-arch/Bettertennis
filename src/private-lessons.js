'use strict';

// Privatni časovi: zajednička pravila za slobodne termine (sarajevsko vrijeme).
const D = require('./dates');
const { zonedTimeToUtc } = require('./weeks');

const TIME_ZONE = 'Europe/Sarajevo';
const NOTIFY_EMAIL_DEFAULT = 'bettertennis.net@gmail.com';

function slotStartMs(slot) {
  const [h, m] = slot.start_time.split(':').map(Number);
  return zonedTimeToUtc(slot.date, h, TIME_ZONE, m);
}

// Termin je za članove vidljiv i dostupan dok nije blokiran i dok ne počne.
function isSlotOpen(slot, now = Date.now()) {
  return !!slot && !slot.blocked && slotStartMs(slot) > now;
}

function slotLabel({ date, start_time: start, end_time: end }) {
  return `${D.formatDateLong(date)} ${start}–${end}`;
}

// Trenutak (ISO) kao „09.10.2026. u 10:00“ po sarajevskom vremenu.
function formatSarajevo(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year}. u ${p.hour}:${p.minute}`;
}

module.exports = { slotStartMs, isSlotOpen, slotLabel, formatSarajevo, NOTIFY_EMAIL_DEFAULT };
