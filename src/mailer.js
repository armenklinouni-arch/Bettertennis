'use strict';

// Slanje e-maila preko Resenda (https://resend.com). Ključ dolazi iz RESEND_API_KEY (Railway → Variables),
// pošiljalac je adresa domene bettertennis.net (domena je verifikovana kod Resenda).
const DEFAULT_FROM = 'BetterTennis <no-reply@bettertennis.net>';
const RESEND_URL = 'https://api.resend.com/emails';

function createResendMailer({ apiKey, from = DEFAULT_FROM, fetch = globalThis.fetch } = {}) {
  return {
    // Vraća true ako je Resend prihvatio poruku; greške se samo zapisuju u log (bez rušenja stranice).
    async send({ to, subject, text, html }) {
      if (!apiKey) {
        console.warn(`E-mail nije poslan (RESEND_API_KEY nije podešen): „${subject}“`);
        return false;
      }
      try {
        const res = await fetch(RESEND_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
        });
        if (!res.ok) {
          console.error(`Resend: slanje nije uspjelo (${res.status}): ${await res.text()}`);
          return false;
        }
        return true;
      } catch (err) {
        console.error('Resend: greška pri slanju e-maila:', err.message);
        return false;
      }
    },
  };
}

module.exports = { createResendMailer, DEFAULT_FROM };
