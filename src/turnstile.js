'use strict';

// Cloudflare Turnstile: provjera tokena iz javnog obrasca na serveru (kod Cloudflarea), prije nego što se išta sačuva.
// Ključevi dolaze iz varijabli okruženja (Railway → Variables), nikad iz koda:
//   TURNSTILE_SITE_KEY   – javni ključ (prikazuje se u obrascu)
//   TURNSTILE_SECRET_KEY – tajni ključ (samo na serveru)
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const ORIGIN = 'https://challenges.cloudflare.com';
const TIMEOUT_MS = 8000;

// Vraća true samo ako Cloudflare potvrdi token. Greška mreže / istek vremena / pogrešan odgovor = false
// (sigurnije: bez potvrde se ništa ne sprema).
async function verifyTurnstile({ secretKey, token, ip, fetch = globalThis.fetch }) {
  if (!secretKey || typeof token !== 'string' || !token || token.length > 2048) return false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const body = new URLSearchParams({ secret: secretKey, response: token, ...(ip ? { remoteip: ip } : {}) });
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res || !res.ok) {
      console.error(`Turnstile: provjera nije uspjela (HTTP ${res ? res.status : '?'})`);
      return false;
    }
    const data = await res.json();
    if (!data || data.success !== true) {
      console.warn(`Turnstile: token odbijen (${(data && data['error-codes'] || []).join(', ') || 'nepoznato'})`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Turnstile: Cloudflare nije dostupan:', err.message);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { verifyTurnstile, SCRIPT_URL, ORIGIN, VERIFY_URL };
