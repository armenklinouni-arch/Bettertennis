'use strict';

const crypto = require('node:crypto');

const COOKIE_NAME = 'bt_session';
const DAY_MS = 1000 * 60 * 60 * 24;
// „Ostani prijavljen“: 90 dana, produžava se pri svakom korištenju stranice.
const SESSION_MAX_AGE_MS = 90 * DAY_MS;
// Bez „Ostani prijavljen“: kolačić bez roka (briše ga zatvaranje preglednika); na serveru najviše 12 h neaktivnosti.
const SHORT_SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
// Rok u bazi se osvježava najviše jednom na sat (manje upisivanja).
const SESSION_TOUCH_MS = 60 * 60 * 1000;
const SESSION_KEYS = { user: 'uid', trainer: 'tid', parent: 'pid' };

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
      // Ko je prijavljen, određuje isključivo sesija u bazi (sid) – uid/tid/pid se ne upisuju u kolačić.
      const { uid, tid, pid, ...stored } = req.session;
      const browserOnly = !!req.session.sid && !req.session.rm;
      const parts = [
        `${COOKIE_NAME}=${encodeSession(stored, secret)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        ...(browserOnly ? [] : [`Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`]),
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

// ---------- Prijave u bazi (ostaju sačuvane i nakon ponovnog pokretanja) ----------

const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const sessionLifetime = (remember) => (remember ? SESSION_MAX_AGE_MS : SHORT_SESSION_IDLE_MS);

// Nova prijava: token u kolačiću, hash u bazi. Postavlja req.session (sačuvati s res.saveSession()).
function startSession(db, req, { kind, id, remember }) {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO sessions (token_hash, kind, account_id, remember, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(tokenHash(token), kind, id, remember ? 1 : 0, now, now, now + sessionLifetime(remember));
  req.session.sid = token;
  req.session.rm = remember ? 1 : 0;
  req.session[SESSION_KEYS[kind]] = id;
}

// Odjava ovog uređaja.
function endSession(db, req) {
  if (typeof req.session.sid === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(req.session.sid));
}

// Nakon promjene/resetovanja lozinke: sve prijave tog računa prestaju (osim, po želji, trenutnog uređaja).
function endSessionsFor(db, kind, id, { keep } = {}) {
  db.prepare('DELETE FROM sessions WHERE kind = ? AND account_id = ? AND token_hash != ?')
    .run(kind, id, typeof keep === 'string' ? tokenHash(keep) : '');
}

// Middleware: provjerava sesiju u bazi i produžava je pri korištenju („Ostani prijavljen“ → opet 90 dana).
function loadSession(db) {
  const get = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  return (req, res, next) => {
    const hadAccount = req.session.uid || req.session.tid || req.session.pid;
    delete req.session.uid;
    delete req.session.tid;
    delete req.session.pid;
    const token = req.session.sid;
    if (typeof token !== 'string') {
      // Stari kolačići (bez sesije u bazi) više ne vrijede.
      if (hadAccount || token !== undefined) {
        delete req.session.sid;
        delete req.session.rm;
        res.saveSession();
      }
      return next();
    }
    const hash = tokenHash(token);
    const row = get.get(hash);
    const now = Date.now();
    if (!row || row.expires_at <= now || !SESSION_KEYS[row.kind]) {
      if (row) remove.run(hash);
      delete req.session.sid;
      delete req.session.rm;
      res.saveSession();
      return next();
    }
    req.session[SESSION_KEYS[row.kind]] = row.account_id;
    if (now - row.last_seen_at >= SESSION_TOUCH_MS) {
      touch.run(now, now + sessionLifetime(row.remember), hash);
      if (row.remember) res.saveSession(); // i kolačić ponovo dobija 90 dana
    }
    next();
  };
}

// Učitava prijavljenog korisnika (samo aktivni računi).
// Treneri imaju vlastiti račun (tabela trainers); u sesiji su zapisani kao tid.
// Za prikaz se predstavljaju kao korisnik s ulogom 'trainer'.
function loadUser(db) {
  const stmt = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1');
  const trainerStmt = db.prepare('SELECT * FROM trainers WHERE id = ? AND active = 1 AND password_hash IS NOT NULL');
  const parentStmt = db.prepare('SELECT * FROM parent_accounts WHERE id = ? AND active = 1');
  const unread = db.prepare('SELECT COUNT(*) AS n FROM news_recipients WHERE user_id = ? AND read_at IS NULL');
  return (req, res, next) => {
    req.user = null;
    if (req.session.uid) {
      req.user = stmt.get(req.session.uid) || null;
    } else if (req.session.tid) {
      const trainer = trainerStmt.get(req.session.tid);
      if (trainer) req.user = { ...trainer, role: 'trainer', trainer_id: trainer.id };
    } else if (req.session.pid) {
      // Roditeljski račun (samo čitanje): u sesiji kao pid, predstavlja se ulogom 'parent'.
      const account = parentStmt.get(req.session.pid);
      if (account) req.user = { ...account, role: 'parent', parent_account_id: account.id };
    }
    // Broj nepročitanih aktuelnosti za oznaku u navigaciji.
    req.unreadNews = req.user && req.user.role === 'member' ? unread.get(req.user.id).n : 0;
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

// Početna stranica nakon prijave, zavisno od uloge.
function homeFor(user) {
  if (user.role === 'admin') return '/admin';
  if (user.role === 'trainer') return '/trener';
  if (user.role === 'parent') return '/roditelj';
  return '/mitglied';
}

function requireLogin(req, res, next) {
  if (!req.user) {
    return res.redirect(`/login?weiter=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// Članski dio: treneri nemaju pristup (vide samo svoj trenerski dio).
function requireMember(req, res, next) {
  if (!req.user) return res.redirect(`/login?weiter=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role === 'trainer') return res.redirect('/trener');
  if (req.user.role === 'parent') return res.redirect('/roditelj');
  next();
}

// Roditeljski račun: samo vlastiti dio (/roditelj), isključivo čitanje.
function requireParentAccount(req, res, next) {
  if (!req.user) return res.redirect(`/login?weiter=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'parent') {
    res.status(403);
    return res.send('Nemate pristup: ovaj dio je samo za roditeljske račune.');
  }
  next();
}

function requireTrainer(req, res, next) {
  if (!req.user) return res.redirect(`/login?weiter=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== 'trainer') {
    res.status(403);
    return res.send('Nemate pristup: ovaj dio je samo za trenere.');
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

// Lesbare Zufallspasswörter für neue Mitglieder: ein Wort + drei Ziffern, z. B. „Teren482“.
// Leicht weiterzugeben und einzutippen (keine Sonderzeichen, keine Kvačice), aber zufällig
// (kryptografischer Zufall; 60 Wörter × 1000 Zahlen). Fehlversuche begrenzt der Login-Limiter.
const PASSWORD_WORDS = [
  'Tenis', 'Teren', 'Reket', 'Loptica', 'Servis', 'Volej', 'Forhend', 'Bekend', 'Pobjeda', 'Trener',
  'Turnir', 'Sunce', 'Zvijezda', 'Planina', 'Rijeka', 'Jabuka', 'Medvjed', 'Sokol', 'Vjetar', 'Oblak',
  'Munja', 'Tigar', 'Delfin', 'Kamen', 'Jezero', 'Dolina', 'Breza', 'Javor', 'Kometa', 'Raketa',
  'Gitara', 'Bubanj', 'Vulkan', 'Ostrvo', 'Talas', 'Lavina', 'Polje', 'Cvijet', 'Pahulja', 'Dugme',
  'Snijeg', 'Lisica', 'Galeb', 'Labud', 'Vjeverica', 'Zebra', 'Panda', 'Koala', 'Banana', 'Limun',
  'Breskva', 'Visnja', 'Malina', 'Kokos', 'Mango', 'Sidro', 'Jedro', 'Kompas', 'Svemir', 'Planet',
];

function readablePassword() {
  const word = PASSWORD_WORDS[crypto.randomInt(PASSWORD_WORDS.length)];
  const digits = String(crypto.randomInt(1000)).padStart(3, '0');
  return `${word}${digits}`;
}

module.exports = {
  hashPassword,
  verifyPassword,
  readablePassword,
  PASSWORD_WORDS,
  DUMMY_HASH,
  sessionMiddleware,
  loadSession,
  startSession,
  endSession,
  endSessionsFor,
  loadUser,
  csrfProtection,
  requireLogin,
  requireMember,
  requireParentAccount,
  requireTrainer,
  homeFor,
  requireAdmin,
  createLoginLimiter,
  // za testove
  encodeSession,
  decodeSession,
};
