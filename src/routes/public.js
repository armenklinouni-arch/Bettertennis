'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { html } = require('../html');
const { layout, csrfField, errorList } = require('../views');
const { verifyPassword, DUMMY_HASH } = require('../auth');

const LEVELS = ['Anfänger', 'Wiedereinsteiger', 'Fortgeschritten', 'Turnierspieler'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Nur interne, relative Weiterleitungen erlauben (kein Open Redirect).
function safeNext(next, fallback) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : fallback;
}

module.exports = function publicRoutes(db, { loginLimiter }) {
  const router = express.Router();

  function homePage(req, { values = {}, errors = [] } = {}) {
    return layout(req, {
      title: 'Tennisstunden',
      body: html`
      <section class="hero">
        <div class="hero-text">
          <p class="eyebrow">Tennisschule</p>
          <h1>Besser Tennis spielen – mit Training, das zu dir passt.</h1>
          <p class="lead">Einzel- und Gruppenstunden für alle Spielstärken. Trag dich unverbindlich ein,
            wir melden uns bei dir und vereinbaren eine Probestunde.</p>
          <a class="btn btn-primary" href="#anmeldung">Jetzt eintragen</a>
          <a class="btn btn-ghost" href="/login">Ich bin schon Mitglied</a>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="court"><span></span></div>
        </div>
      </section>

      <section class="features">
        <div class="feature card">
          <h3>Für jedes Niveau</h3>
          <p>Vom ersten Schlag bis zur Turniervorbereitung – das Training richtet sich nach deinem Spielstand.</p>
        </div>
        <div class="feature card">
          <h3>Fester Wochenplan</h3>
          <p>Als Mitglied siehst du im Login-Bereich alle deine Trainingszeiten von Montag bis Sonntag.</p>
        </div>
        <div class="feature card">
          <h3>Transparente Kosten</h3>
          <p>Du siehst jederzeit, welcher Betrag am Monatsende für deine Stunden anfällt.</p>
        </div>
      </section>

      <section id="anmeldung" class="card form-card">
        <h2>Interesse an Tennisstunden?</h2>
        <p class="muted">Fülle das Formular aus – wir melden uns innerhalb weniger Tage bei dir.</p>
        ${errorList(errors)}
        <form method="post" action="/anmeldung" class="form-grid" novalidate>
          ${csrfField(req)}
          <label>Name *
            <input name="name" required maxlength="120" autocomplete="name" value="${values.name || ''}">
          </label>
          <label>E-Mail *
            <input name="email" type="email" required maxlength="200" autocomplete="email" value="${values.email || ''}">
          </label>
          <label>Telefon
            <input name="phone" type="tel" maxlength="50" autocomplete="tel" value="${values.phone || ''}">
          </label>
          <label>Spielstärke
            <select name="level">
              ${LEVELS.map((l) => html`<option${values.level === l ? ' selected' : ''}>${l}</option>`)}
            </select>
          </label>
          <label class="span-2">Wann hast du Zeit? (Tage / Uhrzeiten)
            <input name="availability" maxlength="300" placeholder="z. B. Di und Do ab 17 Uhr" value="${values.availability || ''}">
          </label>
          <label class="span-2">Nachricht
            <textarea name="message" rows="4" maxlength="2000">${values.message || ''}</textarea>
          </label>
          <label class="hp" aria-hidden="true">Bitte leer lassen
            <input name="website" tabindex="-1" autocomplete="off">
          </label>
          <label class="check span-2">
            <input type="checkbox" name="consent" value="1" required${values.consent ? ' checked' : ''}>
            <span>Ich bin einverstanden, dass meine Angaben zur Kontaktaufnahme gespeichert werden. *</span>
          </label>
          <div class="span-2"><button class="btn btn-primary" type="submit">Unverbindlich eintragen</button></div>
        </form>
      </section>`,
    });
  }

  router.get('/', (req, res) => {
    res.send(String(homePage(req)));
  });

  router.post('/anmeldung', (req, res) => {
    const values = {
      name: str(req.body.name, 120),
      email: str(req.body.email, 200),
      phone: str(req.body.phone, 50),
      level: LEVELS.includes(req.body.level) ? req.body.level : LEVELS[0],
      availability: str(req.body.availability, 300),
      message: str(req.body.message, 2000),
      consent: req.body.consent === '1',
    };

    // Honeypot: Bots füllen das versteckte Feld aus – stillschweigend ignorieren.
    if (str(req.body.website)) return res.redirect('/danke');

    const errors = [];
    if (!values.name) errors.push('Bitte gib deinen Namen an.');
    if (!EMAIL_RE.test(values.email)) errors.push('Bitte gib eine gültige E-Mail-Adresse an.');
    if (!values.consent) errors.push('Bitte bestätige die Einwilligung zur Kontaktaufnahme.');
    if (errors.length) {
      res.status(400);
      return res.send(String(homePage(req, { values, errors })));
    }

    db.prepare(
      'INSERT INTO leads (name, email, phone, level, availability, message) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(values.name, values.email, values.phone || null, values.level, values.availability || null, values.message || null);
    res.redirect('/danke');
  });

  router.get('/danke', (req, res) => {
    res.send(String(layout(req, {
      title: 'Danke',
      body: html`
      <section class="card narrow center">
        <h1>Danke für dein Interesse!</h1>
        <p>Wir haben deine Anfrage erhalten und melden uns in Kürze bei dir.</p>
        <a class="btn btn-primary" href="/">Zur Startseite</a>
      </section>`,
    })));
  });

  function loginPage(req, { email = '', error = null, next = '' } = {}) {
    return layout(req, {
      title: 'Login',
      body: html`
      <section class="card narrow">
        <h1>Mitglieder-Login</h1>
        <p class="muted">Melde dich an, um deinen Wochenplan und deinen Monatsbetrag zu sehen.</p>
        ${error ? errorList([error]) : ''}
        <form method="post" action="/login" class="stack">
          ${csrfField(req)}
          <input type="hidden" name="weiter" value="${next}">
          <label>E-Mail
            <input name="email" type="email" required autocomplete="username" value="${email}" autofocus>
          </label>
          <label>Passwort
            <input name="password" type="password" required autocomplete="current-password">
          </label>
          <button class="btn btn-primary" type="submit">Anmelden</button>
        </form>
        <p class="muted small">Noch kein Mitglied? <a href="/#anmeldung">Hier unverbindlich eintragen.</a></p>
      </section>`,
    });
  }

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/mitglied');
    res.send(String(loginPage(req, { next: str(req.query.weiter, 300) })));
  });

  const findUser = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');

  router.post('/login', (req, res) => {
    const email = str(req.body.email, 200);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const next = str(req.body.weiter, 300);
    const key = req.ip;

    if (loginLimiter.isBlocked(key)) {
      res.status(429);
      return res.send(String(loginPage(req, { email, next, error: 'Zu viele Fehlversuche. Bitte warte einige Minuten.' })));
    }

    const user = findUser.get(email);
    const valid = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && user && user.active;
    if (!valid) {
      loginLimiter.fail(key);
      res.status(401);
      return res.send(String(loginPage(req, { email, next, error: 'E-Mail oder Passwort ist falsch.' })));
    }

    loginLimiter.reset(key);
    req.session = { uid: user.id, csrf: crypto.randomBytes(18).toString('base64url') };
    res.saveSession();
    res.redirect(safeNext(next, user.role === 'admin' ? '/admin' : '/mitglied'));
  });

  router.post('/logout', (req, res) => {
    req.session = { csrf: req.session.csrf };
    res.flash('success', 'Du wurdest abgemeldet.');
    res.redirect('/login');
  });

  return router;
};

module.exports.LEVELS = LEVELS;
module.exports.EMAIL_RE = EMAIL_RE;
module.exports.str = str;
