'use strict';

const path = require('node:path');
const express = require('express');
const { sessionMiddleware, loadUser, csrfProtection, createLoginLimiter } = require('./auth');
const { sessionSecret } = require('./db');
const { closeElapsedMonths } = require('./billing');
const D = require('./dates');
const { createResendMailer } = require('./mailer');
const publicRoutes = require('./routes/public');
const memberRoutes = require('./routes/member');
const adminRoutes = require('./routes/admin');
const trainerRoutes = require('./routes/trainers');
const trainerPortalRoutes = require('./routes/trainer-portal');
const groupRoutes = require('./routes/groups');
const financeRoutes = require('./routes/finance');
const parentPortalRoutes = require('./routes/parent-portal');
const parentAccountRoutes = require('./routes/parents');

function createApp(db, {
  secret, secureCookies = false, trustProxy = false, publicHomepage = false,
  mailer = createResendMailer({ apiKey: process.env.RESEND_API_KEY }), appUrl = 'http://localhost:3000',
} = {}) {
  const app = express();
  // Öffentliche Startseite (Početna): standardmäßig aus – „/“ führt dann direkt zum Login.
  // Die Startseite bleibt im Code erhalten und lässt sich mit PUBLIC_HOMEPAGE=1 wieder einschalten.
  app.locals.publicHomepage = publicHomepage;
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https://unsplash.com https://images.unsplash.com; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    next();
  });

  // Na početku svakog novog mjeseca se završeni mjeseci automatski zaključavaju (obračun ostaje kakav je bio).
  let closedUpTo = null;
  app.use((req, res, next) => {
    const current = D.monthOf(D.todayISO());
    if (current !== closedUpTo) {
      closeElapsedMonths(db, current);
      closedUpTo = current;
    }
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(sessionMiddleware({ secret: sessionSecret(db, secret), secure: secureCookies }));
  app.use(loadUser(db));
  app.use(csrfProtection);

  app.use('/', publicRoutes(db, {
    loginLimiter: createLoginLimiter(), resetLimiter: createLoginLimiter({ maxAttempts: 20 }), resetEmailLimiter: createLoginLimiter({ maxAttempts: 3 }), mailer, appUrl,
  }));
  app.use('/mitglied', memberRoutes(db));
  app.use('/trener', trainerPortalRoutes(db));
  app.use('/roditelj', parentPortalRoutes(db));
  app.use('/admin/treneri', trainerRoutes(db));
  app.use('/admin/grupe', groupRoutes(db));
  app.use('/admin/finansije', financeRoutes(db));
  app.use('/admin/roditelji', parentAccountRoutes(db));
  app.use('/admin', adminRoutes(db));

  app.use((req, res) => {
    res.status(404).send('Stranica nije pronađena.');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send('Došlo je do greške.');
  });

  return app;
}

module.exports = { createApp };
