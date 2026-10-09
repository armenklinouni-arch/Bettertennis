'use strict';

const path = require('node:path');
const express = require('express');
const { sessionMiddleware, loadUser, csrfProtection, createLoginLimiter } = require('./auth');
const { sessionSecret } = require('./db');
const publicRoutes = require('./routes/public');
const memberRoutes = require('./routes/member');
const adminRoutes = require('./routes/admin');
const trainerRoutes = require('./routes/trainers');
const trainerPortalRoutes = require('./routes/trainer-portal');
const groupRoutes = require('./routes/groups');

function createApp(db, { secret, secureCookies = false, trustProxy = false } = {}) {
  const app = express();
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

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(sessionMiddleware({ secret: sessionSecret(db, secret), secure: secureCookies }));
  app.use(loadUser(db));
  app.use(csrfProtection);

  app.use('/', publicRoutes(db, { loginLimiter: createLoginLimiter() }));
  app.use('/mitglied', memberRoutes(db));
  app.use('/trener', trainerPortalRoutes(db));
  app.use('/admin/treneri', trainerRoutes(db));
  app.use('/admin/grupe', groupRoutes(db));
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
