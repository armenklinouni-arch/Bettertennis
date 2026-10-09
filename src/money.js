'use strict';

// Iznosi se čuvaju kao cijeli centi (feninzi) da bi se izbjegle greške zaokruživanja.
// Valuta se može podesiti varijablom CURRENCY (npr. EUR ili BAM za konvertibilnu marku).

const CURRENCY = process.env.CURRENCY || 'EUR';
const formatter = new Intl.NumberFormat('bs-BA', { style: 'currency', currency: CURRENCY });
const CURRENCY_SYMBOL = formatter.formatToParts(0).find((p) => p.type === 'currency').value;

function formatEUR(cents) {
  return formatter.format((cents || 0) / 100);
}

// Za polja unosa: 4550 -> "45,50"
function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

// Prihvata npr. "45", "45,5", "45,50", "1.234,50", "-10", "45.50 €", "45 KM".
// Vraća cente ili null ako unos nije ispravan.
function parseEUR(input) {
  if (input === undefined || input === null) return null;
  let s = String(input).replace(/[\s€]|KM/gi, '');
  if (s === '') return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

function lessonPrice(hourlyRateCents, durationMin) {
  return Math.round((hourlyRateCents * durationMin) / 60);
}

module.exports = { formatEUR, centsToInput, parseEUR, lessonPrice, CURRENCY_SYMBOL };
