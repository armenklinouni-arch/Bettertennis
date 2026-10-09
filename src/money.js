'use strict';

// Beträge werden als ganze Cent gespeichert, um Rundungsfehler zu vermeiden.

const formatter = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });

function formatEUR(cents) {
  return formatter.format((cents || 0) / 100);
}

// Für Eingabefelder: 4550 -> "45,50"
function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

// Akzeptiert z. B. "45", "45,5", "45,50", "1.234,50", "-10", "45.50 €".
// Gibt Cent zurück oder null bei ungültiger Eingabe.
function parseEUR(input) {
  if (input === undefined || input === null) return null;
  let s = String(input).replace(/[\s€]/g, '');
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

module.exports = { formatEUR, centsToInput, parseEUR, lessonPrice };
