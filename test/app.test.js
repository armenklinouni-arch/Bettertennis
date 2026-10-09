'use strict';

process.env.TZ = 'Europe/Berlin';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, ensureAdmin } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const D = require('../src/dates');
const { parseEUR, formatEUR } = require('../src/money');

let server;
let base;
let db;

before(async () => {
  db = openDatabase(':memory:');
  ensureAdmin(db, { email: 'admin@test.de', password: 'adminpass123' });
  const app = createApp(db, { secret: 'test-secret' });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Kleiner Browser-Ersatz mit Cookie-Speicher.
function client() {
  let cookie = '';
  async function request(path, { method = 'GET', form } = {}) {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        cookie,
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async function csrf(path = '/') {
    const page = await request(path);
    const m = /name="_csrf" value="([^"]+)"/.exec(page.text);
    assert.ok(m, `kein CSRF-Token auf ${path}`);
    return m[1];
  }
  async function post(path, form, tokenFrom) {
    const token = await csrf(tokenFrom);
    return request(path, { method: 'POST', form: { _csrf: token, ...form } });
  }
  async function login(email, password) {
    return post('/login', { email, password }, '/login');
  }
  return { request, post, csrf, login };
}

test('Datums- und Geldhilfen', () => {
  assert.equal(D.mondayOf('2026-10-11'), '2026-10-05'); // Sonntag -> Montag
  assert.equal(D.mondayOf('2026-10-05'), '2026-10-05');
  assert.equal(D.isoWeekNumber('2026-10-09'), 41);
  assert.equal(D.isoWeekNumber('2021-01-03'), 53);
  assert.equal(D.addMinutes('17:30', 90), '19:00');
  assert.deepEqual(D.monthRange('2028-02'), { first: '2028-02-01', last: '2028-02-29' });
  assert.equal(D.isValidDate('2026-02-30'), false);
  assert.equal(parseEUR('45,50'), 4550);
  assert.equal(parseEUR('1.234,5'), 123450);
  assert.equal(parseEUR('-10'), -1000);
  assert.equal(parseEUR('abc'), null);
  assert.equal(parseEUR('45,50 KM'), 4550);
  assert.equal(D.formatDateLong('2026-10-05'), 'Ponedjeljak, 05.10.2026.');
  assert.equal(formatEUR(4550).replace(/\s/g, ' '), '45,50 €');
});

test('Content-Security-Policy erlaubt Bilder von Unsplash', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/unsplash\.com https:\/\/images\.unsplash\.com/);
});

test('Interessent kann sich auf der Startseite eintragen', async () => {
  const c = client();
  const home = await c.request('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Zanimaju te časovi tenisa/);
  assert.match(home.text, /<html lang="bs">/);
  assert.match(home.text, /class="hero-photo" src="https:\/\/unsplash\.com\/photos\//);
  assert.match(home.text, /Unsplash<\/figcaption>/);

  const bad = await c.post('/anmeldung', { name: '', email: 'x' });
  assert.equal(bad.status, 400);

  const ok = await c.post('/anmeldung', {
    name: 'Lea Neu', email: 'lea@example.de', level: 'Početnik', availability: 'Di ab 17 Uhr', consent: '1',
  });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/danke');
  const lead = db.prepare('SELECT * FROM leads WHERE email = ?').get('lea@example.de');
  assert.equal(lead.name, 'Lea Neu');
  assert.equal(lead.status, 'novo');
  assert.equal(lead.level, 'Početnik');
});

test('POST ohne gültiges CSRF-Token wird abgelehnt', async () => {
  const c = client();
  const r = await c.request('/anmeldung', { method: 'POST', form: { name: 'X', email: 'x@y.de', consent: '1', _csrf: 'falsch' } });
  assert.equal(r.status, 403);
});

test('Geschützte Bereiche erfordern Login bzw. Admin-Rechte', async () => {
  const anon = client();
  const r1 = await anon.request('/mitglied');
  assert.equal(r1.status, 302);
  assert.match(r1.location, /^\/login/);

  db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Max', 'max@test.de', ?)").run(hashPassword('memberpass1'));
  const member = client();
  const login = await member.login('max@test.de', 'memberpass1');
  assert.equal(login.location, '/mitglied');
  const r2 = await member.request('/admin');
  assert.equal(r2.status, 403);

  const wrong = await client().login('max@test.de', 'falsch');
  assert.equal(wrong.status, 401);
});

test('Admin verwaltet Mitglied, Termine und Beträge; Mitglied sieht Wochenplan und Monatsbetrag', async () => {
  const admin = client();
  const login = await admin.login('admin@test.de', 'adminpass123');
  assert.equal(login.location, '/admin');

  // Mitglied anlegen (aus Interessent)
  const lead = db.prepare('SELECT id FROM leads WHERE email = ?').get('lea@example.de');
  const created = await admin.post('/admin/mitglieder', {
    name: 'Lea Neu', email: 'lea@example.de', password: 'geheim1234', hourly_rate: '40,00', monthly_fee: '10', active: '1', lead_id: String(lead.id),
  }, '/admin/mitglieder/neu');
  assert.equal(created.status, 302);
  const lea = db.prepare('SELECT * FROM users WHERE email = ?').get('lea@example.de');
  assert.equal(lea.hourly_rate_cents, 4000);
  assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'član');

  // Wöchentliche Termine anlegen: 4 × 90 Minuten ab Montag, 5.10.2026
  const t = await admin.post('/admin/termine', {
    user_id: String(lea.id), date: '2026-10-05', start_time: '17:30', duration_min: '90', court: '2', price: '', repeat: '4',
  }, '/admin/termine');
  assert.equal(t.status, 302);
  const lessons = db.prepare('SELECT * FROM lessons WHERE user_id = ? ORDER BY date').all(lea.id);
  assert.deepEqual(lessons.map((l) => l.date), ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  assert.equal(lessons[0].price_cents, 6000);

  // Einen Termin absagen, einen Zusatzposten erfassen
  await admin.post(`/admin/termine/${lessons[1].id}`, {
    user_id: String(lea.id), date: '2026-10-12', start_time: '17:30', duration_min: '90', court: '2', price: '60,00', cancelled: '1',
  }, `/admin/termine/${lessons[1].id}`);
  await admin.post(`/admin/abrechnung/${lea.id}/posten`, { month: '2026-10', description: 'Ballmaschine', amount: '5,50' }, `/admin/abrechnung/${lea.id}?monat=2026-10`);

  // Erwartet: 10 € Grundgebühr + 3 × 60 € + 5,50 € = 195,50 €
  const adminView = await admin.request('/admin/abrechnung?monat=2026-10');
  assert.match(adminView.text, /195,50/);

  // Mitglied loggt sich ein
  const member = client();
  const ml = await member.login('lea@example.de', 'geheim1234');
  assert.equal(ml.location, '/mitglied');
  const week = await member.request('/mitglied?woche=2026-10-07');
  assert.equal(week.status, 200);
  assert.match(week.text, /41\. sedmica/);
  for (const day of D.DAY_NAMES) assert.ok(week.text.includes(day), `${day} fehlt`);
  assert.match(week.text, /17:30–19:00 h/);
  assert.match(week.text, /Lea Neu/);
  assert.match(week.text, /Ponedjeljak, 05\.10\.2026\./);

  const bill = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(bill.text, /195,50/);
  assert.match(bill.text, /Ballmaschine/);
  assert.match(bill.text, /samo informativan/);

  // Mitglied sieht keine fremden Termine
  const other = db.prepare("SELECT id FROM users WHERE email = 'max@test.de'").get();
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-06', '09:00', 60, 3000)").run(other.id);
  const week2 = await member.request('/mitglied?woche=2026-10-05');
  assert.doesNotMatch(week2.text, /09:00–10:00/);

  // Deaktiviertes Mitglied kann sich nicht mehr einloggen
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(lea.id);
  const blocked = await client().login('lea@example.de', 'geheim1234');
  assert.equal(blocked.status, 401);
});

test('Eingaben werden HTML-escaped', async () => {
  const c = client();
  await c.post('/anmeldung', { name: '<script>alert(1)</script>', email: 'xss@example.de', consent: '1' });
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const page = await admin.request('/admin/interessenten');
  assert.ok(!page.text.includes('<script>alert(1)</script>'));
  assert.ok(page.text.includes('&lt;script&gt;'));
});
