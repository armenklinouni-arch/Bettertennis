'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { html, raw } = require('../html');
const { layout, csrfField, errorList } = require('../views');
const {
  verifyPassword, hashPassword, DUMMY_HASH, homeFor, startSession, endSession, endSessionsFor,
} = require('../auth');
const { isPlaceholderEmail, needsEmailPrompt } = require('../db');

const LEVELS = ['Početnik', 'Povratnik', 'Napredni', 'Takmičar'];

// Fotografija teniskog terena s Unsplasha (Unsplash licenca, besplatno za korištenje, navođenje autora nije obavezno).
// Izvor: https://unsplash.com/photos/a-clay-tennis-court-with-lines-msx3rGYfOEc (Aleksandr Galichkin).
// Slika je spremljena lokalno, pa se prikazuje i bez interneta.
const HERO_PHOTO_SRC = '/static/img/tennisplatz.jpg';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Broj telefona: dozvoljeni su brojevi, razmaci i + / ( ) - . ; najmanje 6 cifara.
const PHONE_RE = /^\+?[0-9\s/().-]+$/;

function isValidPhone(phone) {
  return PHONE_RE.test(phone) && phone.replace(/\D/g, '').length >= 6;
}

const unsplashLarge = (id) => `https://unsplash.com/photos/${id}/download?w=1600`;
// Hero: 4 tenis fotografije s Unsplasha (Unsplash licenca, besplatno), polako se smjenjuju.
// Ako se neka ne učita, prikazuje se lokalna fotografija terena (HERO_PHOTO_SRC).
const HERO_SLIDES = [
  'yKMJLLtoDv4', // igračica u pokretu
  'AldB5IWh8l4', // servis
  'aG6ByqGXiXg', // teren odozgo, dva igrača
  'LwxVG0VQ3RY', // loptice uz mrežu
];

// Jednostavne, jednake linijske ikone (24×24, stroke = currentColor).
const LINE_ICON = (paths) => raw(`<svg class="line-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths}</svg>`);
const ICONS = {
  // nivoi: tri stupca
  levels: LINE_ICON('<path d="M3 20h18"/><path d="M6 20v-5"/><path d="M12 20v-9"/><path d="M18 20V5"/>'),
  // kalendar
  calendar: LINE_ICON('<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/><path d="M8 14.5h3"/>'),
  // medalja
  medal: LINE_ICON('<circle cx="12" cy="15" r="5.5"/><circle cx="12" cy="15" r="2"/><path d="M8.6 10.6 6 3h4l2 4.4L14 3h4l-2.6 7.6"/>'),
  // reket i loptica (individualni trening)
  racket: LINE_ICON('<ellipse cx="9" cy="9" rx="6.5" ry="5" transform="rotate(45 9 9)"/><path d="M4.4 4.4 13.6 13.6"/><path d="M5.5 12.5 12.5 5.5"/><path d="m13.6 13.6 6.4 6.4"/><circle cx="19" cy="5" r="1.75"/>'),
  // dvije osobe (grupni trening)
  group: LINE_ICON('<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16 14.1a4.5 4.5 0 0 1 5 4.4"/>'),
  // kamera (video analiza)
  video: LINE_ICON('<rect x="2.5" y="6.5" width="13.5" height="11" rx="2.5"/><path d="m16 10.5 5.5-3v9l-5.5-3"/>'),
  // dva oblačića razgovora (konsultacije)
  chat: LINE_ICON('<path d="M4.5 4.5h9a2 2 0 0 1 2 2V12a2 2 0 0 1-2 2H9l-3.5 3v-3h-1a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z"/><path d="M18 9h1.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1v2.5L15.5 18h-3"/>'),
};
// Programi na početnoj stranici. Svaka kartica prikazuje linijsku ikonu. Vlastitu fotografiju dodaješ bez izmjene
// koda: snimi je u public/img/programi/ pod imenom kartice (npr. individualni.jpg) – vidi LIESMICH.md u tom folderu.
const PROGRAMS = [
  { slug: 'individualni', icon: 'racket', tag: 'Jedan na jedan', title: 'Individualni trening',
    alt: 'Individualni trening',
    text: 'Trening jedan na jedan, potpuno prilagođen tvom tempu i ciljevima – najbrži napredak u tehnici i taktici.' },
  { slug: 'grupni', icon: 'group', tag: 'Mala grupa', title: 'Grupni trening',
    alt: 'Grupni trening',
    text: 'Trening u maloj grupi igrača sličnog nivoa. Više igre, motivacije i druženja.' },
  { slug: 'video-analiza', icon: 'video', tag: 'Tehnika', title: 'Video analiza',
    alt: 'Video analiza',
    text: 'Snimamo tvoje udarce i analiziramo ih usporeno, kadar po kadar – vidiš tačno šta i kako popraviti.' },
  { slug: 'konsultacije', icon: 'chat', tag: 'Plan i savjeti', title: 'Konsultacije',
    alt: 'Konsultacije',
    text: 'Razgovaramo o tvojim ciljevima, planu treninga, opremi i pripremi za turnire.' },
];

// Folder za vlastite fotografije kartica i dozvoljeni formati (koristi se prvi pronađeni).
const PROGRAM_PHOTO_DIR = path.join(__dirname, '..', '..', 'public', 'img', 'programi');
const PROGRAM_PHOTO_TYPES = ['jpg', 'jpeg', 'png', 'webp'];

// Gornji dio kartice: vlastita fotografija iz public/img/programi/<slug>.(jpg|jpeg|png|webp), inače linijska ikona.
function programMedia(pr, dir = PROGRAM_PHOTO_DIR) {
  for (const type of PROGRAM_PHOTO_TYPES) {
    let stat = null;
    try {
      stat = fs.statSync(path.join(dir, `${pr.slug}.${type}`));
    } catch {
      // nema fotografije u ovom formatu
    }
    if (stat && stat.isFile()) {
      // ?v= osigurava da preglednik nakon zamjene fotografije učita novu verziju
      return html`<div class="program-img"><img src="/static/img/programi/${pr.slug}.${type}?v=${Math.floor(stat.mtimeMs)}" alt="${pr.alt}" width="400" height="300" loading="lazy" decoding="async"></div>`;
    }
  }
  return html`<div class="program-icon feature-icon" aria-hidden="true">${ICONS[pr.icon]}</div>`;
}

function str(v, max = 500) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Dozvoljena su samo interna, relativna preusmjeravanja (bez open redirecta).
function safeNext(next, fallback) {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : fallback;
}

module.exports = function publicRoutes(db, {
  loginLimiter, resetLimiter, resetEmailLimiter, mailer, appUrl = '',
}) {
  const router = express.Router();

  function homePage(req, { values = {}, errors = [] } = {}) {
    return layout(req, {
      title: 'Časovi tenisa',
      fullBleed: true,
      body: html`
      <div class="home">
      <section class="hero home-hero" aria-label="BetterTennis – teniska škola">
        <div class="hero-slides" aria-hidden="true">${HERO_SLIDES.map((id, i) => html`
          <img class="hero-photo hero-slide" src="${unsplashLarge(id)}" data-fallback="${HERO_PHOTO_SRC}" alt="" width="1600" height="1067"
            loading="${i === 0 ? 'eager' : 'lazy'}" decoding="async" referrerpolicy="no-referrer"${i === 0 ? raw(' fetchpriority="high"') : ''}>`)}
        </div>
        <div class="home-hero-shade" aria-hidden="true"></div>
        <div class="home-hero-inner">
          <div class="hero-text">
            <img class="logo-full hero-logo" src="/static/img/logo.png" alt="BetterTennis – teniska škola" width="96" height="127">
            <p class="eyebrow">Teniska škola</p>
            <h1>Igraj <span class="hl">bolji tenis</span> – uz trening koji ti odgovara.</h1>
            <p class="lead">Individualni i grupni časovi za sve nivoe znanja. Prijavi se bez obaveze
              i javit ćemo ti se u najkraćem roku.</p>
            <div class="hero-actions">
              <a class="btn btn-neon btn-lg" href="/login">Već sam član</a>
              <a class="btn btn-outline-light btn-lg" href="#anmeldung">Prijavi se sada</a>
            </div>
            <ul class="hero-chips" aria-label="Ukratko">
              <li>ITF treneri</li><li>Djeca i odrasli</li><li>Video analiza</li>
            </ul>
          </div>
        </div>
      </section>

      <div class="home-band">
      <div class="home-wrap">
      <section class="section" id="programi" aria-labelledby="programi-naslov">
        <div class="section-head reveal">
          <p class="eyebrow">Naši programi</p>
          <h2 id="programi-naslov">Trening po tvojoj mjeri</h2>
          <p class="muted">Biraj između individualnog i grupnog treninga, a uz to nudimo video analizu i konsultacije.</p>
        </div>
        <div class="program-grid">
          ${PROGRAMS.map((pr, i) => html`
          <article class="program-card lift reveal delay-${i % 4}">
            ${programMedia(pr)}
            <div class="program-body">
              <span class="tag tag-kind is-group">${pr.tag}</span>
              <h3>${pr.title}</h3>
              <p>${pr.text}</p>
            </div>
          </article>`)}
        </div>
      </section>
      </div>
      </div>

      <div class="home-wrap">
      <section class="section features" aria-label="Zašto BetterTennis">
        <div class="feature card lift reveal">
          <div class="feature-icon" aria-hidden="true">${ICONS.levels}</div>
          <h3>Za svaki nivo</h3>
          <p>Treninzi su prilagođeni svim nivoima – od početnika do naprednih igrača. Nudimo grupne i individualne treninge,
            video analizu i konsultacije.</p>
        </div>
        <div class="feature card lift reveal delay-1">
          <div class="feature-icon" aria-hidden="true">${ICONS.calendar}</div>
          <h3>Sedmični raspored</h3>
          <p>Kao član u svom profilu vidiš sve termine treninga od ponedjeljka do nedjelje.</p>
        </div>
        <div class="feature card lift reveal delay-2">
          <div class="feature-icon" aria-hidden="true">${ICONS.medal}</div>
          <h3>Treneri</h3>
          <p>Svi naši treneri su certificirani ITF treneri sa dugogodišnjim iskustvom.</p>
        </div>
      </section>

      <section id="anmeldung" class="card form-card reveal">
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
          <div class="span-2"><button class="btn btn-accent btn-lg" type="submit">Prijavi se bez obaveze</button></div>
        </form>
      </section>
      </div>
      </div>`,
    });
  }

  router.get('/', (req, res) => {
    // Startseite deaktiviert: direkt zum Login (bzw. eingeloggt zur eigenen Seite).
    // 302 statt 301, damit Browser die Umleitung nicht dauerhaft speichern.
    if (!req.app.locals.publicHomepage) return res.redirect(302, req.user ? homeFor(req.user) : '/login');
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

  function loginPage(req, { username = '', error = null, next = '', remember = true } = {}) {
    return layout(req, {
      title: 'Prijava',
      body: html`
      <section class="card narrow">
        <img class="logo-full login-logo" src="/static/img/logo.png" alt="BetterTennis" width="88" height="117">
        <h1>Prijava za članove</h1>
        <p class="muted">Prijavi se da vidiš svoj sedmični raspored i mjesečni iznos.</p>
        ${error ? errorList([error]) : ''}
        <form method="post" action="/login" class="stack">
          ${csrfField(req)}
          <input type="hidden" name="weiter" value="${next}">
          <label>Korisničko ime
            <input name="username" type="text" required maxlength="200" autocomplete="username" autocapitalize="none" spellcheck="false" value="${username}" autofocus>
          </label>
          <label>Lozinka
            <input name="password" type="password" required autocomplete="current-password">
          </label>
          <label class="check remember">
            <input type="checkbox" name="remember" value="1"${remember ? ' checked' : ''}>
            <span>Ostani prijavljen</span>
          </label>
          <button class="btn btn-primary" type="submit">Prijavi se</button>
        </form>
        <p class="small"><a href="/zaboravljena-lozinka">Zaboravljena lozinka?</a></p>
        <p class="muted small">Administrator se prijavljuje svojom e-mail adresom.</p>
        ${req.app.locals.publicHomepage ? html`<p class="muted small">Još nisi član? <a href="/#anmeldung">Prijavi se ovdje bez obaveze.</a></p>` : ''}
      </section>`,
    });
  }

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(homeFor(req.user));
    res.send(String(loginPage(req, { next: str(req.query.weiter, 300) })));
  });

  // Članovi i treneri: korisničko ime. Administrator: e-mail adresa (kao i do sada).
  const findMember = db.prepare("SELECT * FROM users WHERE role = 'member' AND username = ? COLLATE NOCASE");
  const findTrainer = db.prepare('SELECT * FROM trainers WHERE username = ? COLLATE NOCASE AND password_hash IS NOT NULL');
  const findAdmin = db.prepare("SELECT * FROM users WHERE role = 'admin' AND email = ? COLLATE NOCASE");
  const findParentAccount = db.prepare('SELECT * FROM parent_accounts WHERE username = ? COLLATE NOCASE');

  router.post('/login', (req, res) => {
    const username = str(req.body.username ?? req.body.email, 200);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const next = str(req.body.weiter, 300);
    const key = req.ip;

    if (loginLimiter.isBlocked(key)) {
      res.status(429);
      return res.send(String(loginPage(req, { username, next, error: 'Previše neuspjelih pokušaja. Molimo sačekaj nekoliko minuta.' })));
    }

    // Prvo članovi, zatim treneri s aktiviranim pristupom, na kraju administrator po e-mail adresi.
    const user = findMember.get(username) || (username.includes('@') ? findAdmin.get(username) : null);
    const trainer = user ? null : findTrainer.get(username);
    const parentAccount = user || trainer ? null : findParentAccount.get(username);
    const account = user || trainer || parentAccount;
    // Pri kopiranju lozinke često se slučajno doda razmak na početku ili kraju – i to dozvoljavamo.
    const hash = account ? account.password_hash : DUMMY_HASH;
    const passwordOk = verifyPassword(password, hash) || (password.trim() !== password && verifyPassword(password.trim(), hash));
    const valid = passwordOk && account && account.active;
    if (!valid) {
      loginLimiter.fail(key);
      res.status(401);
      return res.send(String(loginPage(req, { username, next, remember: req.body.remember === '1', error: 'Korisničko ime ili lozinka nisu ispravni.' })));
    }

    loginLimiter.reset(key);
    const csrf = crypto.randomBytes(18).toString('base64url');
    // „Ostani prijavljen“ (u obrascu unaprijed označeno): 90 dana; bez kvačice do zatvaranja preglednika.
    const remember = req.body.remember === '1';
    req.session = { csrf };
    if (user) {
      startSession(db, req, { kind: 'user', id: user.id, remember });
      // Prozor za unos e-maila: prikazuje se u ovoj prijavi (najviše kod prve tri prijave bez e-maila).
      if (needsEmailPrompt(user)) {
        db.prepare('UPDATE users SET email_prompt_logins = email_prompt_logins + 1 WHERE id = ?').run(user.id);
        req.session.emailPrompt = 1;
      }
    } else if (trainer) startSession(db, req, { kind: 'trainer', id: trainer.id, remember });
    else startSession(db, req, { kind: 'parent', id: parentAccount.id, remember });
    res.saveSession();
    res.redirect(safeNext(next, user ? homeFor(user) : trainer ? '/trener' : '/roditelj'));
  });

  // ---------------------------------------------------------------- Zaboravljena lozinka
  // Član unese e-mail adresu i dobije jednokratni link (60 min) za novu lozinku. Korisničko ime se ne mijenja.
  // Odgovor je uvijek isti – da se ne može provjeriti koja e-mail adresa postoji.
  const RESET_VALID_MS = 60 * 60 * 1000;
  const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
  const resetMember = db.prepare("SELECT * FROM users WHERE role = 'member' AND active = 1 AND email = ? COLLATE NOCASE");
  const findReset = db.prepare(
    `SELECT r.*, u.username, u.name FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.active = 1 AND u.role = 'member'`
  );

  function forgotPage(req, { sent = false, email = '' } = {}) {
    return layout(req, {
      title: 'Zaboravljena lozinka',
      body: html`
      <section class="card narrow">
        <h1>Zaboravljena lozinka</h1>
        ${sent
          ? html`<p class="notice">Ako je ta e-mail adresa povezana s članskim računom, poslali smo link za novu lozinku.
              Provjeri svoj e-mail (i folder za neželjenu poštu). Link vrijedi 60 minuta.</p>`
          : html`<p class="muted">Unesi e-mail adresu koju si sačuvao/la u svom profilu. Poslat ćemo ti link za postavljanje nove lozinke.
              Tvoje korisničko ime ostaje isto.</p>`}
        <form method="post" action="/zaboravljena-lozinka" class="stack">
          ${csrfField(req)}
          <label>E-mail adresa
            <input name="email" type="email" required maxlength="200" autocomplete="email" value="${email}">
          </label>
          <button class="btn btn-primary" type="submit">Pošalji link</button>
        </form>
        <p class="muted small"><a href="/login">← Nazad na prijavu</a> · Nemaš sačuvan e-mail? Javi se teniskoj školi.</p>
      </section>`,
    });
  }

  router.get('/zaboravljena-lozinka', (req, res) => {
    res.send(String(forgotPage(req)));
  });

  router.post('/zaboravljena-lozinka', async (req, res, next) => {
    try {
      const email = str(req.body.email, 200);
      // Zaštita od zloupotrebe: najviše 20 zahtjeva po IP adresi i 3 linka po e-mail adresi u 15 minuta.
      const ipKey = `reset:${req.ip}`;
      const mailKey = `reset-mail:${email.toLowerCase()}`;
      const blocked = (resetLimiter && resetLimiter.isBlocked(ipKey)) || (resetEmailLimiter && resetEmailLimiter.isBlocked(mailKey));
      if (resetLimiter) resetLimiter.fail(ipKey);
      if (resetEmailLimiter && !blocked) resetEmailLimiter.fail(mailKey);
      const member = !blocked && EMAIL_RE.test(email) ? resetMember.get(email) : null;
      if (member && !isPlaceholderEmail(member.email)) {
        const token = crypto.randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
          .run(tokenHash(token), member.id, Date.now() + RESET_VALID_MS);
        const link = `${appUrl}/nova-lozinka/${token}`;
        await mailer.send({
          to: member.email,
          subject: 'BetterTennis – nova lozinka',
          text: `Zdravo ${member.name},\n\nzatražena je nova lozinka za tvoj BetterTennis račun.\n`
            + `Tvoje korisničko ime: ${member.username}\n\n`
            + `Novu lozinku postavi preko ovog linka (vrijedi 60 minuta):\n${link}\n\n`
            + 'Ako nisi ti zatražio/la novu lozinku, jednostavno zanemari ovaj e-mail.\n\nBetterTennis',
          html: String(html`<p>Zdravo ${member.name},</p>
            <p>zatražena je nova lozinka za tvoj BetterTennis račun.<br>Tvoje korisničko ime: <strong>${member.username}</strong></p>
            <p><a href="${link}">Postavi novu lozinku</a> (link vrijedi 60 minuta)</p>
            <p style="color:#666">Ako link ne radi, kopiraj ovu adresu u preglednik:<br>${link}</p>
            <p>Ako nisi ti zatražio/la novu lozinku, jednostavno zanemari ovaj e-mail.</p><p>BetterTennis</p>`),
        });
      }
      res.send(String(forgotPage(req, { sent: true })));
    } catch (err) {
      next(err);
    }
  });

  function resetPage(req, { token, account, errors = [] }) {
    return layout(req, {
      title: 'Nova lozinka',
      body: html`
      <section class="card narrow">
        <h1>Nova lozinka</h1>
        ${account
          ? html`
            <p class="muted">Korisničko ime: <strong>${account.username}</strong> (ostaje isto).</p>
            ${errorList(errors)}
            <form method="post" action="/nova-lozinka/${token}" class="stack">
              ${csrfField(req)}
              <label>Nova lozinka (najmanje 8 znakova)
                <input name="password" type="password" required minlength="8" autocomplete="new-password">
              </label>
              <label>Ponovi novu lozinku
                <input name="password2" type="password" required minlength="8" autocomplete="new-password">
              </label>
              <button class="btn btn-primary" type="submit">Sačuvaj novu lozinku</button>
            </form>`
          : html`<p class="notice">Ovaj link nije važeći ili je istekao. <a href="/zaboravljena-lozinka">Zatraži novi link.</a></p>`}
      </section>`,
    });
  }

  router.get('/nova-lozinka/:token', (req, res) => {
    const account = findReset.get(tokenHash(String(req.params.token)), Date.now());
    if (!account) res.status(400);
    res.send(String(resetPage(req, { token: req.params.token, account })));
  });

  router.post('/nova-lozinka/:token', (req, res) => {
    const account = findReset.get(tokenHash(String(req.params.token)), Date.now());
    if (!account) {
      res.status(400);
      return res.send(String(resetPage(req, { token: req.params.token, account: null })));
    }
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const errors = [];
    if (password.length < 8) errors.push('Lozinka mora imati najmanje 8 znakova.');
    if (password !== req.body.password2) errors.push('Lozinke se ne podudaraju.');
    if (errors.length) {
      res.status(400);
      return res.send(String(resetPage(req, { token: req.params.token, account, errors })));
    }
    // Samo lozinka – korisničko ime se ne mijenja. Svi otvoreni linkovi tog člana prestaju važiti.
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), account.user_id);
      endSessionsFor(db, 'user', account.user_id); // sve postojeće prijave ovog računa prestaju
      db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(Date.now(), account.user_id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    res.flash('success', `Nova lozinka je sačuvana. Prijavi se korisničkim imenom ${account.username}.`);
    res.redirect('/login');
  });

  router.post('/logout', (req, res) => {
    endSession(db, req); // odmah nevažeće – i za kopirani kolačić
    req.session = { csrf: req.session.csrf };
    res.flash('success', 'Odjavljen/a si.');
    res.redirect('/login');
  });

  return router;
};

module.exports.LEVELS = LEVELS;
module.exports.EMAIL_RE = EMAIL_RE;
module.exports.str = str;
module.exports.programMedia = programMedia;
module.exports.PROGRAM_PHOTO_DIR = PROGRAM_PHOTO_DIR;
