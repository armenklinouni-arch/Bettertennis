'use strict';

// Minimal, sicheres Templating: alle eingesetzten Werte werden escaped,
// außer sie sind bereits als SafeHtml markiert (z. B. verschachtelte html``-Ergebnisse).

class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(renderValue).join('');
  if (value instanceof SafeHtml) return value.value;
  return escapeHtml(value);
}

function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

function raw(value) {
  return new SafeHtml(String(value));
}

module.exports = { html, raw, escapeHtml, SafeHtml };
