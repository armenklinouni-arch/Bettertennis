'use strict';

// Dvojezičnost: bosanski (standard) i engleski. Svi fiksni tekstovi za posjetioce, članove, roditelje,
// djecu i trenere su u src/i18n/bs.js i src/i18n/en.js (isti ključevi). Admin dio je uvijek na bosanskom.
// Sadržaj koji unosi admin (imena, stavke, napomene, aktuelnosti) se ne prevodi.
const bs = require('./bs');
const en = require('./en');

const DICTS = { bs, en };
const LANGS = ['bs', 'en'];
const DEFAULT_LANG = 'bs';

function normalizeLang(lang) {
  return LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

// t(lang, 'ključ', { varijable }) – {ime} u tekstu se zamjenjuje; funkcije dobijaju varijable; nizovi se vraćaju kakvi jesu.
function t(lang, key, vars = {}) {
  const dict = DICTS[normalizeLang(lang)];
  const value = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : bs[key];
  if (value === undefined) throw new Error(`i18n: nepoznat ključ „${key}“`);
  if (typeof value === 'function') return value(vars);
  if (typeof value !== 'string') return value;
  return value.replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}

// Jezik sačuvanog računa (account_prefs.lang); bez izbora → bosanski.
function accountLang(db, kind, id) {
  const row = db.prepare('SELECT lang FROM account_prefs WHERE kind = ? AND account_id = ?').get(kind, id);
  return normalizeLang(row && row.lang);
}

module.exports = { t, normalizeLang, accountLang, LANGS, DEFAULT_LANG };
