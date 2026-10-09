'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'bt_session';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14; // 14 dana

// ---------- Lozinke (scrypt) ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Lažni hash, da prijava s nepoznatim e-mailom traje jednako dugo.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---------- Potpisani session-kolačići ----------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function encodeSession(data, secret) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function decodeSession(value, secret) {
  if (!value || !value.includes('.')) return null;
  const [payload, signature] = value.split('.');
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object' || (data.exp && data.exp < Date.now())) return null;
    return data;
  } catch {
    return null;
  }
}

// Middleware: req.session je običan objekat; promjene se upisuju pomoću res.saveSession().
function sessionMiddleware({ secret, secure }) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    req.session = decodeSession(cookies[COOKIE_NAME], secret) || {};
    const isNew = !req.session.csrf;
    if (isNew) req.session.csrf = crypto.randomBytes(18).toString('base64url');

    res.saveSession = () => {
      req.session.exp = Date.now() + SESSION_MAX_AGE_MS;
      const parts = [
        `${COOKIE_NAME}=${encodeSession(req.session, secret)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
      ];
      if (secure) parts.push('Secure');
      res.setHeader('Set-Cookie', parts.join('; '));
    };

    res.flash = (type, message) => {
      req.session.flash = { type, message };
      res.saveSession();
    };

    // Flash-poruku prikazati tačno jednom.
    req.takeFlash = () => {
      const flash = req.session.flash;
      if (flash) {
        delete req.session.flash;
        res.saveSession();
      }
      return flash || null;
    };

    if (isNew) res.saveSession();
    next();
  };
}

// Učitava prijavljenog korisnika (samo aktivni računi).
function loadUser(db) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');
  return (req, res, next) => {
    req.user = req.session.uid ? stmt.get(req.session.uid) || null : null;
    next();
  };
}

// Zaštita od Cross-Site-Request-Forgery za sve POST zahtjeve.
function csrfProtection(req, res, next) {
  if (req.method !== 'POST') return next();
  const token = req.body && req.body._csrf;
  const expected = req.session.csrf;
  const ok =
    typeof token === 'string' &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) {
    res.status(403);
    return res.send('Neispravan token obrasca. Molimo osvježite stranicu i pokušajte ponovo.');
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    return res.redirect(`/login?weiter=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.redirect(`/login?weiter=${encodeURIComponent(req.originalUrl)}`);
  }
  if (req.user.role !== 'admin') {
    res.status(403);
    return res.send('Nemate pristup: ovaj dio je samo za administratore.');
  }
  next();
}

// Jednostavno ograničenje neuspjelih prijava po IP adresi (u memoriji).
function createLoginLimiter({ maxAttempts = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return {
    isBlocked(key) {
      const entry = attempts.get(key);
      if (!entry) return false;
      if (Date.now() - entry.first > windowMs) {
        attempts.delete(key);
        return false;
      }
      return entry.count >= maxAttempts;
    },
    fail(key) {
      const entry = attempts.get(key);
      if (!entry || Date.now() - entry.first > windowMs) attempts.set(key, { count: 1, first: Date.now() });
      else entry.count++;
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  sessionMiddleware,
  loadUser,
  csrfProtection,
  requireLogin,
  requireAdmin,
  createLoginLimiter,
  // za testove
  encodeSession,
  decodeSession,
};
