'use strict';

// Filter za liste (Iznosi, Članovi): bez razlike velika/mala slova i kvačica (č, ć, š, ž, đ).
// „đ“ se može tražiti kao „d“ ili „dj“. Ista pravila koristi i /static/app.js za filtriranje pri kucanju.

function fold(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Normalizovani tekst za pretragu (đ → d).
function normalizeSearch(text) {
  return fold(String(text || '').toLowerCase().replace(/đ/g, 'd')).replace(/\s+/g, ' ').trim();
}

// Tekst jedne osobe za pretragu: ime i korisničko ime, i varijanta s „dj“ za „đ“.
function searchText(...parts) {
  const raw = parts.filter(Boolean).join(' ');
  const plain = normalizeSearch(raw);
  const dj = normalizeSearch(String(raw).toLowerCase().replace(/đ/g, 'dj'));
  return dj === plain ? plain : `${plain} | ${dj}`;
}

// Odgovara ako se svaka riječ upita nalazi u tekstu.
function matchesSearch(haystack, query) {
  const terms = normalizeSearch(query).split(' ').filter(Boolean);
  return terms.every((t) => haystack.includes(t));
}

module.exports = { normalizeSearch, searchText, matchesSearch };
