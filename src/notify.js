'use strict';

// Ručno slanje e-mailova članovima (otkazani termin, aktuelnost). Nikad automatski – samo kad admin
// u listi odabere primaoce i pritisne „Pošalji“. Pamti se ko je za šta već obaviješten.
const { html } = require('./html');
const { csrfField } = require('./views');
const { isPlaceholderEmail } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasEmail(user) {
  return typeof user.email === 'string' && EMAIL_RE.test(user.email) && !isPlaceholderEmail(user.email);
}

function informedIds(db, kind, ref) {
  return new Set(db.prepare('SELECT user_id FROM notification_log WHERE kind = ? AND ref = ?').all(kind, String(ref)).map((r) => r.user_id));
}

function selectedIds(body) {
  return new Set([].concat(body.recipients || []).map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Šalje pojedinačne e-mailove odabranim članovima iz `users` (samo onima s e-mailom koji još nisu obaviješteni).
// build(user) vraća { subject, text, html }. Greške se zapisuju u log (Resend razlog + ova linija).
async function sendToSelected(db, mailer, { kind, ref, users, selected, build, logLabel, logContext = '', delayMs = 0 }) {
  const done = informedIds(db, kind, ref);
  const record = db.prepare('INSERT OR IGNORE INTO notification_log (kind, ref, user_id, email) VALUES (?, ?, ?, ?)');
  const targets = users.filter((u) => selected.has(u.id) && hasEmail(u) && !done.has(u.id));
  const result = { sent: 0, failed: 0, skipped: selected.size - targets.length };
  for (const [i, user] of targets.entries()) {
    if (i > 0 && delayMs) await pause(delayMs); // Resend dozvoljava samo nekoliko poruka u sekundi
    let ok = false;
    let reason = 'slanje preko Resenda nije uspjelo (detalji u liniji iznad)';
    try {
      ok = await mailer.send({ to: user.email, ...build(user) });
    } catch (err) {
      reason = err.message;
    }
    if (ok) {
      record.run(kind, String(ref), user.id, user.email);
      result.sent += 1;
    } else {
      result.failed += 1;
      console.error(`${logLabel} nije poslan na ${user.email} (${user.name}${logContext ? `; ${logContext}` : ''}): ${reason}`);
    }
  }
  return result;
}

function resultMessage({ sent, failed }) {
  const parts = [];
  if (sent) parts.push(`E-mail je poslan: ${sent} ${sent === 1 ? 'primalac' : 'primaoca'}.`);
  if (failed) parts.push(`Za ${failed} ${failed === 1 ? 'primaoca' : 'primalaca'} e-mail nije poslan – razlog je u logovima.`);
  if (!sent && !failed) parts.push('Nijedan e-mail nije poslan: niko nije odabran (ili su odabrani već obaviješteni / bez e-maila).');
  return parts.join(' ');
}

// Zajednička lista primalaca: kvačica, ime, e-mail. Bez e-maila → „nije dostupno“ (nije moguće odabrati),
// već obaviješteni → oznaka „već obaviješten/a“ (također nije moguće ponovo odabrati). Ništa nije unaprijed označeno.
function recipientForm(req, { action, users, informed, fields = '', submitLabel = 'Pošalji' }) {
  return html`
    <form method="post" action="${action}" class="stack recipient-form">
      ${csrfField(req)}
      ${fields}
      <div class="table-wrap"><table class="recipient-table">
        <thead><tr>
          <th><label class="check select-all"><input type="checkbox" data-select-all><span>Označi sve</span></label></th>
          <th>Ime</th><th>E-mail</th>
        </tr></thead>
        <tbody>${users.length === 0
          ? html`<tr><td colspan="3" class="empty">Nema članova.</td></tr>`
          : users.map((u) => {
            const reachable = hasEmail(u);
            const already = informed.has(u.id);
            return html`<tr class="recipient-row${already ? ' is-informed' : ''}${reachable ? '' : ' is-unavailable'}"><td><input type="checkbox" name="recipients" value="${u.id}"${reachable && !already ? '' : ' disabled'}></td><td class="recipient-name">${u.name}</td><td class="recipient-mail">${reachable
              ? html`${u.email}${already ? html` <span class="tag tag-done">već obaviješten/a</span>` : ''}`
              : html`<span class="muted">nije dostupno</span>`}</td></tr>`;
          })}</tbody>
      </table></div>
      <div class="btn-row"><button class="btn btn-primary" type="submit">${submitLabel}</button></div>
    </form>`;
}

module.exports = { hasEmail, informedIds, selectedIds, sendToSelected, resultMessage, recipientForm };
