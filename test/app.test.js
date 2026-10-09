'use strict';

process.env.TZ = 'Europe/Berlin';

const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, ensureAdmin } = require('../src/db');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const D = require('../src/dates');
const { parseMoney, formatMoney } = require('../src/money');

let server;
let base;
let db;

before(async () => {
  // Fester Testzeitpunkt, damit „aktueller Monat“ und „3 Monate zurück“ nicht vom echten Datum abhängen.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T10:00:00') });
  db = openDatabase(':memory:');
  ensureAdmin(db, { email: 'admin@test.de', password: 'adminpass123' });
  const app = createApp(db, { secret: 'test-secret' });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Formulardaten kodieren; Arrays werden wie bei Checkboxen als wiederholte Felder gesendet.
function toFormBody(form) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  return params.toString();
}

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
      body: form ? toFormBody(form) : undefined,
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
  assert.equal(parseMoney('45,50'), 4550);
  assert.equal(parseMoney('1.234,5'), 123450);
  assert.equal(parseMoney('-10'), -1000);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('45,50 KM'), 4550);
  assert.equal(D.formatDateLong('2026-10-05'), 'Ponedjeljak, 05.10.2026.');
  assert.equal(formatMoney(4550).replace(/\s/g, ' '), '45,50 KM');
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
  assert.doesNotMatch(home.text, /figcaption/);
  assert.match(home.text, /certificirani ITF treneri/);
  assert.doesNotMatch(home.text, /Transparentni/);

  const bad = await c.post('/anmeldung', { name: '', email: 'x' });
  assert.equal(bad.status, 400);

  // Broj telefona je obavezan
  const noPhone = await c.post('/anmeldung', { name: 'Bez Telefona', email: 'bez@example.de', consent: '1' });
  assert.equal(noPhone.status, 400);
  assert.match(noPhone.text, /Molimo upiši broj telefona/);
  const badPhone = await c.post('/anmeldung', { name: 'Bez Telefona', email: 'bez@example.de', phone: 'abc', consent: '1' });
  assert.equal(badPhone.status, 400);

  const ok = await c.post('/anmeldung', {
    name: 'Lea Neu', email: 'lea@example.de', phone: '061 123 456', level: 'Početnik', availability: 'Di ab 17 Uhr', consent: '1',
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
  const r = await c.request('/anmeldung', { method: 'POST', form: { name: 'X', email: 'x@y.de', phone: '061 123 456', consent: '1', _csrf: 'falsch' } });
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
    user_id: String(lea.id), date: '2026-10-12', start_time: '17:30', duration_min: '90', court: '2', price: '60,00', status: 'cancelled', kind: 'individual',
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

  // Status: neue Termine sind „Realizovan“, abgesagte „Otkazan“
  assert.match(week.text, /Realizovan/);
  const cancelledWeek = await member.request('/mitglied?woche=2026-10-12');
  assert.match(cancelledWeek.text, /Otkazan/);

  // Gruppentraining: Lea + Max; Lea sieht nur sich selbst, Admin sieht beide
  const g = await admin.post('/admin/termine', {
    kind: 'group', user_id: String(lea.id), member_ids: String(other.id), date: '2026-10-08', start_time: '18:00', duration_min: '60', price: '25', repeat: '1',
  }, '/admin/termine');
  assert.equal(g.status, 302);
  const groupRows = db.prepare("SELECT * FROM lessons WHERE kind = 'group' ORDER BY user_id").all();
  assert.equal(groupRows.length, 2);
  assert.ok(groupRows[0].group_id && groupRows[0].group_id === groupRows[1].group_id);
  assert.deepEqual(groupRows.map((r) => r.price_cents), [2500, 2500]);
  const leaWeek = await member.request('/mitglied?woche=2026-10-05');
  assert.match(leaWeek.text, /Grupni trening/);
  assert.doesNotMatch(leaWeek.text, /Max/);
  const adminWeek = await admin.request('/admin/termine?woche=2026-10-05');
  assert.match(adminWeek.text, /Lea Neu, Max|Max, Lea Neu/);

  // Gruppe ohne zweites Mitglied wird abgelehnt
  const bad = await admin.post('/admin/termine', {
    kind: 'group', user_id: String(lea.id), date: '2026-10-09', start_time: '18:00', duration_min: '60',
  }, '/admin/termine');
  assert.equal(bad.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE date = '2026-10-09'").get().n, 0);

  // Gruppe mit bis zu 8 Mitgliedern; mehr als 8 wird abgelehnt
  const extra = [];
  for (let i = 1; i <= 8; i++) {
    extra.push(db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
      .run(`Gruppe ${i}`, `gruppe${i}@test.de`, hashPassword('memberpass1')).lastInsertRowid);
  }
  const eight = await admin.post('/admin/termine', {
    kind: 'group', user_id: String(extra[0]), member_ids: extra.slice(1, 8).map(String), date: '2026-10-10', start_time: '09:00', duration_min: '60', price: '20',
  }, '/admin/termine');
  assert.equal(eight.status, 302);
  const eightRows = db.prepare("SELECT * FROM lessons WHERE date = '2026-10-10'").all();
  assert.equal(eightRows.length, 8);
  assert.equal(new Set(eightRows.map((r) => r.group_id)).size, 1);
  await admin.post('/admin/termine', {
    kind: 'group', user_id: String(lea.id), member_ids: extra.map(String), date: '2026-10-11', start_time: '09:00', duration_min: '60',
  }, '/admin/termine');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE date = '2026-10-11'").get().n, 0);
  const editPage = await admin.request(`/admin/termine/${eightRows[0].id}`);
  assert.equal((editPage.text.match(/name="member_ids" value="\d+" checked/g) || []).length, 7);
  db.prepare("DELETE FROM lessons WHERE date = '2026-10-10'").run();
  for (const id of extra) db.prepare('DELETE FROM users WHERE id = ?').run(id);

  // Status der ganzen Gruppe auf „Otkazan“ setzen
  await admin.post(`/admin/termine/${groupRows[0].id}/status`, { status: 'cancelled' }, '/admin/termine?woche=2026-10-05');
  assert.deepEqual(db.prepare("SELECT cancelled FROM lessons WHERE kind = 'group'").all().map((r) => r.cancelled), [1, 1]);

  // Manueller Obračun: Termine zählen nicht, nur Grundgebühr + Posten
  db.prepare("UPDATE users SET billing_mode = 'manual' WHERE id = ?").run(lea.id);
  const manualBill = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(manualBill.text, /15,50/); // 10 KM Grundgebühr + 5,50 KM Posten
  assert.match(manualBill.text, /Ručni obračun/);
  // Prikaz bez obračuna: termini sichtbar, aber nicht berechnet
  db.prepare("UPDATE users SET billing_mode = 'display' WHERE id = ?").run(lea.id);
  const displayBill = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(displayBill.text, /15,50/);
  assert.match(displayBill.text, /samo prikaz, bez obračuna/);
  assert.match(displayBill.text, /17:30–19:00/);
  db.prepare("UPDATE users SET billing_mode = 'schedule' WHERE id = ?").run(lea.id);

  // Admin kann Abrechnungsart „display“ über das Formular setzen
  await admin.post(`/admin/mitglieder/${lea.id}`, {
    name: 'Lea Neu', email: 'lea@example.de', hourly_rate: '40,00', monthly_fee: '10', active: '1', billing_mode: 'display',
  }, `/admin/mitglieder/${lea.id}`);
  assert.equal(db.prepare('SELECT billing_mode FROM users WHERE id = ?').get(lea.id).billing_mode, 'display');
  db.prepare("UPDATE users SET billing_mode = 'schedule' WHERE id = ?").run(lea.id);

  // Plaćeno / nije plaćeno: standardmäßig offen, Admin markiert als bezahlt
  let billNow = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(billNow.text, /Nije plaćeno/);
  const paidRes = await admin.post(`/admin/abrechnung/${lea.id}/placeno`, { month: '2026-10', paid: '1' }, '/admin/abrechnung?monat=2026-10');
  assert.equal(paidRes.status, 302);
  billNow = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(billNow.text, /tag-done">Plaćeno/);

  // Mitglieder sehen nur 3 Monate zurück (ältere Anfragen werden begrenzt)
  const old = await member.request('/mitglied/abrechnung?monat=2026-01');
  assert.match(old.text, /<strong>Juli 2026<\/strong>/);
  assert.doesNotMatch(old.text, /monat=2026-06/);

  // Aktuelnosti: nur an Lea; Lea sieht sie ungelesen, Max nicht
  const sent = await admin.post('/admin/aktuelnosti', {
    title: 'Klupski turnir', body: 'Turnir u subotu u 10 h.', audience: 'some', member_ids: String(lea.id),
  }, '/admin/aktuelnosti');
  assert.equal(sent.status, 302);
  const inbox = await member.request('/mitglied/aktuelnosti');
  assert.match(inbox.text, /Klupski turnir/);
  assert.match(inbox.text, /class="count"[^>]*>1</);
  const newsId = db.prepare('SELECT id FROM news WHERE title = ?').get('Klupski turnir').id;
  const article = await member.request(`/mitglied/aktuelnosti/${newsId}`);
  assert.match(article.text, /Turnir u subotu u 10 h\./);
  assert.ok(db.prepare('SELECT read_at FROM news_recipients WHERE news_id = ? AND user_id = ?').get(newsId, lea.id).read_at);
  const maxClient = client();
  await maxClient.login('max@test.de', 'memberpass1');
  const maxInbox = await maxClient.request('/mitglied/aktuelnosti');
  assert.doesNotMatch(maxInbox.text, /Klupski turnir/);
  assert.equal((await maxClient.request(`/mitglied/aktuelnosti/${newsId}`)).status, 404);

  // Deaktiviertes Mitglied kann sich nicht mehr einloggen
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(lea.id);
  const blocked = await client().login('lea@example.de', 'geheim1234');
  assert.equal(blocked.status, 401);
});

test('Eingaben werden HTML-escaped', async () => {
  const c = client();
  await c.post('/anmeldung', { name: '<script>alert(1)</script>', email: 'xss@example.de', phone: '061 000 000', consent: '1' });
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const page = await admin.request('/admin/interessenten');
  assert.ok(!page.text.includes('<script>alert(1)</script>'));
  assert.ok(page.text.includes('&lt;script&gt;'));
});
