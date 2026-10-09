'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { html } = require('../html');
const { layout, csrfField, errorList } = require('../views');
const { verifyPassword, DUMMY_HASH } = require('../auth');

const LEVELS = ['Početnik', 'Povratnik', 'Napredni', 'Takmičar'];

// Fotografija teniskog terena s Unsplasha (Unsplash licenca, besplatno za korištenje, navođenje autora nije obavezno).
// Izvor: https://unsplash.com/photos/a-clay-tennis-court-with-lines-msx3rGYfOEc (Aleksandr Galichkin)
const HERO_PHOTO_SRC = 'https://unsplash.com/photos/msx3rGYfOEc/download?w=1200';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Broj telefona: dozvoljeni su brojevi, razmaci i + / ( ) - . ; najmanje 6 cifara.
const PHONE_RE = /^\+?[0-9\s/().-]+$/;

function isValidPhone(phone) {
  return PHONE_RE.test(phone) && phone.replace(/\D/g, '').length >= 6;
}

function str(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Dozvoljena su samo interna, relativna preusmjeravanja (bez open redirecta).
function safeNext(next, fallback) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : fallback;
}

module.exports = function publicRoutes(db, { loginLimiter }) {
  const router = express.Router();

  function homePage(req, { values = {}, errors = [] } = {}) {
    return layout(req, {
      title: 'Časovi tenisa',
      body: html`
      <section class="hero">
        <div class="hero-text">
          <p class="eyebrow">Teniska škola</p>
          <h1>Igraj bolji tenis – uz trening koji ti odgovara.</h1>
          <p class="lead">Individualni i grupni časovi za sve nivoe znanja. Prijavi se bez obaveze,
            javit ćemo ti se i dogovoriti probni trening.</p>
          <a class="btn btn-primary" href="#anmeldung">Prijavi se sada</a>
          <a class="btn btn-ghost" href="/login">Već sam član</a>
        </div>
        <figure class="hero-art">
          <div class="court" aria-hidden="true"><span></span></div>
          <img class="hero-photo" src="${HERO_PHOTO_SRC}" alt="Teniski teren od šljake s bijelim linijama"
            width="1200" height="1600" loading="eager" referrerpolicy="no-referrer">
        </figure>
      </section>

      <section class="features">
        <div class="feature card">
          <h3>Za svaki nivo</h3>
          <p>Treninzi su prilagođeni svim nivoima – od početnika do naprednih igrača. Nudimo grupne i individualne treninge,
            video analizu i konsultacije.</p>
        </div>
        <div class="feature card">
          <h3>Sedmični raspored</h3>
          <p>Kao član u svom profilu vidiš sve termine treninga od ponedjeljka do nedjelje.</p>
        </div>
        <div class="feature card">
          <h3>Treneri</h3>
          <p>Svi naši treneri su certificirani ITF treneri sa dugogodišnjim iskustvom.</p>
        </div>
      </section>

      <section id="anmeldung" class="card form-card">
        <h2>Zanimaju te časovi tenisa?</h2>
        <p class="muted">Popuni obrazac – javit ćemo ti se u roku od nekoliko dana.</p>
        ${errorList(errors)}
        <form method="post" action="/anmeldung" class="form-grid" novalidate>
          ${csrfField(req)}
          <label>Ime i prezime *
            <input name="name" required maxlength="120" autocomplete="name" value="${values.name || ''}">
          </label>
          <label>E-mail *
            <input name="email" type="email" required maxlength="200" autocomplete="email" value="${values.email || ''}">
          </label>
          <label>Broj telefona *
            <input name="phone" type="tel" required maxlength="50" autocomplete="tel" placeholder="npr. 061 123 456" value="${values.phone || ''}">
          </label>
          <label>Nivo znanja
            <select name="level">
              ${LEVELS.map((l) => html`<option${values.level === l ? ' selected' : ''}>${l}</option>`)}
            </select>
          </label>
          <label class="span-2">Kada imaš vremena? (dani / sati)
            <input name="availability" maxlength="300" placeholder="npr. utorkom i četvrtkom od 17 h" value="${values.availability || ''}">
          </label>
          <label class="span-2">Poruka
            <textarea name="message" rows="4" maxlength="2000">${values.message || ''}</textarea>
          </label>
          <label class="hp" aria-hidden="true">Molimo ostavite prazno
            <input name="website" tabindex="-1" autocomplete="off">
          </label>
          <label class="check span-2">
            <input type="checkbox" name="consent" value="1" required${values.consent ? ' checked' : ''}>
            <span>Slažem se da se moji podaci sačuvaju radi kontakta. *</span>
          </label>
          <div class="span-2"><button class="btn btn-primary" type="submit">Prijavi se bez obaveze</button></div>
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

    // Honeypot: botovi popunjavaju skriveno polje – tiho ignorisati.
    if (str(req.body.website)) return res.redirect('/danke');

    const errors = [];
    if (!values.name) errors.push('Molimo upiši svoje ime.');
    if (!EMAIL_RE.test(values.email)) errors.push('Molimo upiši ispravnu e-mail adresu.');
    if (!values.phone) errors.push('Molimo upiši broj telefona.');
    else if (!isValidPhone(values.phone)) errors.push('Molimo upiši ispravan broj telefona.');
    if (!values.consent) errors.push('Molimo potvrdi saglasnost za kontakt.');
    if (errors.length) {
      res.status(400);
      return res.send(String(homePage(req, { values, errors })));
    }

    db.prepare(
      'INSERT INTO leads (name, email, phone, level, availability, message) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(values.name, values.email, values.phone, values.level, values.availability || null, values.message || null);
    res.redirect('/danke');
  });

  router.get('/danke', (req, res) => {
    res.send(String(layout(req, {
      title: 'Hvala',
      body: html`
      <section class="card narrow center">
        <h1>Hvala na interesovanju!</h1>
        <p>Primili smo tvoj upit i uskoro ćemo ti se javiti.</p>
        <a class="btn btn-primary" href="/">Na početnu stranicu</a>
      </section>`,
    })));
  });

  function loginPage(req, { email = '', error = null, next = '' } = {}) {
    return layout(req, {
      title: 'Prijava',
      body: html`
      <section class="card narrow">
        <h1>Prijava za članove</h1>
        <p class="muted">Prijavi se da vidiš svoj sedmični raspored i mjesečni iznos.</p>
        ${error ? errorList([error]) : ''}
        <form method="post" action="/login" class="stack">
          ${csrfField(req)}
          <input type="hidden" name="weiter" value="${next}">
          <label>E-mail
            <input name="email" type="email" required autocomplete="username" value="${email}" autofocus>
          </label>
          <label>Lozinka
            <input name="password" type="password" required autocomplete="current-password">
          </label>
          <button class="btn btn-primary" type="submit">Prijavi se</button>
        </form>
        <p class="muted small">Još nisi član? <a href="/#anmeldung">Prijavi se ovdje bez obaveze.</a></p>
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
      return res.send(String(loginPage(req, { email, next, error: 'Previše neuspjelih pokušaja. Molimo sačekaj nekoliko minuta.' })));
    }

    const user = findUser.get(email);
    const valid = verifyPassword(password, user ? user.password_hash : DUMMY_HASH) && user && user.active;
    if (!valid) {
      loginLimiter.fail(key);
      res.status(401);
      return res.send(String(loginPage(req, { email, next, error: 'E-mail ili lozinka nisu ispravni.' })));
    }

    loginLimiter.reset(key);
    req.session = { uid: user.id, csrf: crypto.randomBytes(18).toString('base64url') };
    res.saveSession();
    res.redirect(safeNext(next, user.role === 'admin' ? '/admin' : '/mitglied'));
  });

  router.post('/logout', (req, res) => {
    req.session = { csrf: req.session.csrf };
    res.flash('success', 'Odjavljen/a si.');
    res.redirect('/login');
  });

  return router;
};

module.exports.LEVELS = LEVELS;
module.exports.EMAIL_RE = EMAIL_RE;
module.exports.str = str;
