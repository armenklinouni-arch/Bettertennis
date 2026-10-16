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
  // Hauptinstanz mit eingeschalteter Startseite (deren Tests bleiben so erhalten).
  const app = createApp(db, { secret: 'test-secret', publicHomepage: true });
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

test('Startseitenfoto lokal, Programmfotos von Unsplash erlaubt', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/unsplash\.com https:\/\/images\.unsplash\.com;/);
  const img = await fetch(base + '/static/img/tennisplatz.jpg');
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
});

test('Interessent kann sich auf der Startseite eintragen', async () => {
  const c = client();
  const home = await c.request('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Zanimaju te časovi tenisa/);
  assert.match(home.text, /<html lang="bs">/);
  assert.match(home.text, /class="hero-photo" src="\/static\/img\/tennisplatz\.jpg"/);
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

  db.prepare("INSERT INTO users (name, username, email, password_hash) VALUES ('Max', 'max', 'max@test.de', ?)").run(hashPassword('memberpass1'));
  const member = client();
  const login = await member.login('max', 'memberpass1');
  assert.equal(login.location, '/mitglied');
  const r2 = await member.request('/admin');
  assert.equal(r2.status, 403);

  const wrong = await client().login('max', 'falsch');
  assert.equal(wrong.status, 401);
});

test('Admin verwaltet Mitglied, Termine und Beträge; Mitglied sieht Wochenplan und Monatsbetrag', async () => {
  const admin = client();
  const login = await admin.login('admin@test.de', 'adminpass123');
  assert.equal(login.location, '/admin');

  // Mitglied anlegen (aus Interessent)
  const lead = db.prepare('SELECT id FROM leads WHERE email = ?').get('lea@example.de');
  const created = await admin.post('/admin/mitglieder', {
    name: 'Lea Neu', username: 'Lea', email: 'lea@example.de', password: 'geheim1234', hourly_rate: '40,00', monthly_fee: '10', active: '1', lead_id: String(lead.id),
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
  const ml = await member.login('lea', 'geheim1234');
  assert.equal(ml.location, '/mitglied');
  const week = await member.request('/mitglied?woche=2026-10-07');
  assert.equal(week.status, 200);
  assert.match(week.text, /41\. sedmica/);
  for (const day of D.DAY_NAMES) assert.ok(week.text.includes(day), `${day} fehlt`);
  assert.match(week.text, /17:30–19:00 h/);
  assert.match(week.text, /Lea Neu/);
  assert.match(week.text, /Ponedjeljak, 05\.10\.2026\./);

  // Obračun ist zuerst „u pripremi“ – Mitglied sieht keinen Betrag
  const pending = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(pending.text, /Obračun u pripremi/);
  assert.doesNotMatch(pending.text, /195,50/);
  assert.doesNotMatch(pending.text, /Ballmaschine/);
  const pendingWeek = await member.request('/mitglied?woche=2026-10-07');
  assert.match(pendingWeek.text, /Obračun u pripremi/);
  // Admin gibt den Monat frei
  const rel = await admin.post(`/admin/abrechnung/${lea.id}/odobri`, { month: '2026-10', released: '1' }, '/admin/abrechnung?monat=2026-10');
  assert.equal(rel.status, 302);

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
  // Kommende Woche sieht das Mitglied erst nach der Freigabe
  assert.doesNotMatch((await member.request('/mitglied?woche=2026-10-12')).text, /Otkazan/);
  await admin.post('/admin/termine/sedmica/objavi', { monday: '2026-10-12' }, '/admin/termine?woche=2026-10-12');
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
  // Beim Bearbeiten einer Gruppe sind alle 8 Spieler angehakt
  assert.equal((editPage.text.match(/name="member_ids" value="\d+" checked/g) || []).length, 8);

  // Gruppe nur über Häkchen (ohne Feld „Član“) – so wie nach Auswahl einer stalne grupe
  const viaChecks = await admin.post('/admin/termine', {
    kind: 'group', user_id: '', member_ids: extra.slice(0, 3).map(String), date: '2026-10-12', start_time: '09:00', duration_min: '60',
  }, '/admin/termine');
  assert.equal(viaChecks.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE date = '2026-10-12' AND start_time = '09:00'").get().n, 3);
  db.prepare("DELETE FROM lessons WHERE date = '2026-10-12' AND start_time = '09:00'").run();
  // Nur ein Häkchen reicht für eine Gruppe nicht
  await admin.post('/admin/termine', { kind: 'group', member_ids: String(extra[0]), date: '2026-10-13', start_time: '09:00', duration_min: '60' }, '/admin/termine');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE date = '2026-10-13'").get().n, 0);
  db.prepare("DELETE FROM lessons WHERE date = '2026-10-10'").run();
  for (const id of extra) db.prepare('DELETE FROM users WHERE id = ?').run(id);

  // Status der ganzen Gruppe auf „Otkazan“ setzen
  await admin.post(`/admin/termine/${groupRows[0].id}/status`, { status: 'cancelled' }, '/admin/termine?woche=2026-10-05');
  assert.deepEqual(db.prepare("SELECT cancelled FROM lessons WHERE kind = 'group'").all().map((r) => r.cancelled), [1, 1]);

  // Manueller Obračun: Termine zählen nicht, nur Grundgebühr + Posten
  const setMode = (mode, month = '2026-10') => admin.post(`/admin/abrechnung/${lea.id}/nacin`, { month, billing_mode: mode }, `/admin/abrechnung/${lea.id}?monat=${month}`);
  await setMode('manual');
  const manualBill = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(manualBill.text, /15,50/); // 10 KM Grundgebühr + 5,50 KM Posten
  assert.match(manualBill.text, /Ručni obračun/);
  // Admin kann den Obračun wieder „u pripremu“ setzen und erneut freigeben
  await admin.post(`/admin/abrechnung/${lea.id}/odobri`, { month: '2026-10', released: '0' }, '/admin/abrechnung?monat=2026-10');
  assert.match((await member.request('/mitglied/abrechnung?monat=2026-10')).text, /Obračun u pripremi/);
  await admin.post('/admin/abrechnung/odobri-sve', { month: '2026-10', released: '1' }, '/admin/abrechnung?monat=2026-10');
  assert.match((await member.request('/mitglied/abrechnung?monat=2026-10')).text, /15,50/); // noch manuell

  // Prikaz bez obračuna: termini sichtbar, aber nicht berechnet
  await setMode('display');
  const displayBill = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(displayBill.text, /15,50/);
  assert.match(displayBill.text, /samo prikaz, bez obračuna/);
  assert.match(displayBill.text, /17:30–19:00/);
  // Andere Monate bleiben unberührt
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_months WHERE user_id = ? AND month != '2026-10' AND mode != 'schedule'").get(lea.id).n, 0);
  assert.match((await admin.request(`/admin/abrechnung/${lea.id}?monat=2026-11`)).text, /value="schedule" selected/);
  await setMode('schedule');

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
  await maxClient.login('max', 'memberpass1');
  const maxInbox = await maxClient.request('/mitglied/aktuelnosti');
  assert.doesNotMatch(maxInbox.text, /Klupski turnir/);
  assert.equal((await maxClient.request(`/mitglied/aktuelnosti/${newsId}`)).status, 404);

  // Deaktiviertes Mitglied kann sich nicht mehr einloggen
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(lea.id);
  const blocked = await client().login('lea', 'geheim1234');
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

test('Trainer: anlegen, Terminen zuordnen, Bericht mit Einzel/Gruppe, Zusatzzahlung', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const ids = ['Ana', 'Ben', 'Cem'].map((n) => db.prepare('INSERT INTO users (name, username, email, password_hash, hourly_rate_cents) VALUES (?, ?, ?, ?, 4000)')
    .run(n, n.toLowerCase(), `${n.toLowerCase()}@trainer-test.de`, hashPassword('memberpass1')).lastInsertRowid);

  const created = await admin.post('/admin/treneri', { name: 'Trener Test', username: 'trener.test', rate_individual: '25,00', rate_group: '30', active: '1' }, '/admin/treneri/neu');
  assert.equal(created.status, 302);
  const trainer = db.prepare("SELECT * FROM trainers WHERE name = 'Trener Test'").get();
  assert.equal(trainer.rate_individual_cents, 2500);
  assert.equal(trainer.rate_group_cents, 3000);

  // Einzeltraining 60 min, Gruppe (3 Mitglieder) 90 min, ein abgesagtes Einzeltraining
  await admin.post('/admin/termine', { kind: 'individual', trainer_id: String(trainer.id), user_id: String(ids[0]), date: '2026-11-02', start_time: '10:00', duration_min: '60' }, '/admin/termine');
  await admin.post('/admin/termine', { kind: 'group', trainer_id: String(trainer.id), user_id: String(ids[0]), member_ids: [String(ids[1]), String(ids[2])], date: '2026-11-03', start_time: '10:00', duration_min: '90', price: '20' }, '/admin/termine');
  await admin.post('/admin/termine', { kind: 'individual', trainer_id: String(trainer.id), user_id: String(ids[1]), date: '2026-11-04', start_time: '10:00', duration_min: '60' }, '/admin/termine');
  const groupLessons = db.prepare("SELECT * FROM lessons WHERE date = '2026-11-03'").all();
  assert.equal(groupLessons.length, 3);
  assert.ok(groupLessons.every((l) => l.trainer_id === trainer.id));
  const cancelLesson = db.prepare("SELECT id FROM lessons WHERE date = '2026-11-04'").get();
  await admin.post(`/admin/termine/${cancelLesson.id}/status`, { status: 'cancelled' }, '/admin/termine');

  // Zusatzzahlung (Prämie)
  await admin.post(`/admin/treneri/${trainer.id}/dodatno`, { month: '2026-11', description: 'Nagrada', amount: '50' }, `/admin/treneri/${trainer.id}?monat=2026-11`);

  const { trainerReport } = require('../src/trainers');
  const r = trainerReport(db, trainer, '2026-11');
  assert.equal(r.individual.count, 1);
  assert.equal(r.individual.pay, 2500); // 60 min × 25 KM
  assert.equal(r.group.count, 1); // Gruppe zählt einmal
  assert.equal(r.group.pay, 4500); // 90 min × 30 KM
  assert.equal(r.bonusTotal, 5000);
  assert.equal(r.payTotal, 12000);
  assert.equal(r.valueTotal, 4000 + 3 * 2000);
  assert.equal(r.margin, 10000 - 12000);

  const page = await admin.request('/admin/treneri?monat=2026-11');
  assert.match(page.text, /Trener Test/);
  assert.match(page.text, /120,00\sKM/);
  const detail = await admin.request(`/admin/treneri/${trainer.id}?monat=2026-11`);
  assert.match(detail.text, /Ana, Ben, Cem/);
  assert.match(detail.text, /Nagrada/);

  // Mitglied darf den Trainer NICHT sehen (Wochenplan, Monatsbetrag)
  await admin.post('/admin/termine/sedmica/objavi', { monday: '2026-11-02' }, '/admin/termine?woche=2026-11-02');
  const ana = client();
  await ana.login('ana', 'memberpass1');
  const week = await ana.request('/mitglied?woche=2026-11-02');
  assert.match(week.text, /10:00–11:00/);
  assert.doesNotMatch(week.text, /Trener Test|Trener:/);
  const anaBill = await ana.request('/mitglied/abrechnung?monat=2026-10');
  assert.doesNotMatch(anaBill.text, /Trener Test/);
  // Admin sieht den Trainer weiterhin
  const adminWeek = await admin.request('/admin/termine?woche=2026-11-02');
  assert.match(adminWeek.text, /Trener: Trener Test/);

  // Trainer löschen: Termine bleiben, ohne Trainer
  await admin.post(`/admin/treneri/${trainer.id}/loeschen`, {}, `/admin/treneri/${trainer.id}/uredi`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE date = '2026-11-03' AND trainer_id IS NULL").get().n, 3);
});

test('Trainer-Konto: sieht nur eigene Stunden, Gruppen und Spieler; Rollen sind getrennt', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const m = ['Dino', 'Edin', 'Faris'].map((n) => db.prepare('INSERT INTO users (name, username, email, password_hash, hourly_rate_cents) VALUES (?, ?, ?, ?, 3000)')
    .run(n, n.toLowerCase(), `${n.toLowerCase()}@portal-test.de`, hashPassword('memberpass1')).lastInsertRowid);

  // Trainer mit Login anlegen, zweiter Trainer ohne Login
  await admin.post('/admin/treneri', { name: 'Mirza Trener', username: 'mirza', email: 'mirza@portal-test.de', password: 'trener1234', rate_individual: '20', rate_group: '30', active: '1' }, '/admin/treneri/neu');
  await admin.post('/admin/treneri', { name: 'Drugi Trener', username: 'drugi', rate_individual: '99', rate_group: '99', active: '1' }, '/admin/treneri/neu');
  const mirza = db.prepare("SELECT * FROM trainers WHERE name = 'Mirza Trener'").get();
  const other = db.prepare("SELECT * FROM trainers WHERE name = 'Drugi Trener'").get();
  assert.ok(mirza.password_hash);
  assert.equal(other.password_hash, null);

  // Benutzername ist eindeutig – auch über Mitglieder und Trainer hinweg; ohne Benutzername kein Trainer
  const dup = await admin.post('/admin/treneri', { name: 'Dupli', username: 'Dino', password: 'trener1234', active: '1' }, '/admin/treneri/neu');
  assert.equal(dup.status, 400);
  assert.match(dup.text, /korisničko ime je već zauzeto/);
  const noName = await admin.post('/admin/treneri', { name: 'Bez imena', active: '1' }, '/admin/treneri/neu');
  assert.equal(noName.status, 400);

  await admin.post('/admin/termine', { kind: 'individual', trainer_id: String(mirza.id), user_id: String(m[0]), date: '2026-09-07', start_time: '09:00', duration_min: '60' }, '/admin/termine');
  await admin.post('/admin/termine', { kind: 'group', trainer_id: String(mirza.id), user_id: String(m[0]), member_ids: [String(m[1]), String(m[2])], date: '2026-09-08', start_time: '09:00', duration_min: '90', price: '15' }, '/admin/termine');
  await admin.post('/admin/termine', { kind: 'individual', trainer_id: String(other.id), user_id: String(m[1]), date: '2026-09-09', start_time: '11:00', duration_min: '60' }, '/admin/termine');

  const t = client();
  const login = await t.login('Mirza', 'trener1234');
  assert.equal(login.location, '/trener');
  const report = await t.request('/trener?monat=2026-09');
  assert.equal(report.status, 200);
  assert.match(report.text, /3 igrača:<\/strong> Dino, Edin, Faris/);
  assert.match(report.text, /65,00\sKM/); // 20 KM + 1,5 h × 30 KM
  assert.match(report.text, /Ukupno do danas/);
  assert.doesNotMatch(report.text, /Drugi Trener|11:00–12:00/); // fremde Termine nicht sichtbar
  assert.doesNotMatch(report.text, /Vrijednost|Razlika/); // keine Mitgliederpreise
  const plan = await t.request('/trener/raspored?woche=2026-09-07');
  assert.match(plan.text, /Dino, Edin, Faris \(3 igrača\)/);
  assert.doesNotMatch(plan.text, /11:00–12:00/);

  // Rollen getrennt
  assert.equal((await t.request('/mitglied')).location, '/trener');
  assert.equal((await t.request('/admin')).status, 403);
  assert.equal((await t.request('/admin/treneri')).status, 403);
  const member = client();
  await member.login('dino', 'memberpass1');
  assert.equal((await member.request('/trener')).status, 403);

  // Zugang entziehen
  await admin.post(`/admin/treneri/${mirza.id}`, { name: 'Mirza Trener', username: 'mirza', email: 'mirza@portal-test.de', rate_individual: '20', rate_group: '30', active: '1', revoke: '1' }, `/admin/treneri/${mirza.id}/uredi`);
  assert.equal((await client().login('mirza', 'trener1234')).status, 401);
  assert.equal((await t.request('/trener')).status, 302);
});

test('Stalne grupe: anlegen, im Terminformular auswählbar, bearbeiten, löschen', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const ids = ['Goran', 'Hana', 'Ilma'].map((n) => db.prepare('INSERT INTO users (name, username, email, password_hash) VALUES (?, ?, ?, ?)')
    .run(n, n.toLowerCase(), `${n.toLowerCase()}@grupe-test.de`, hashPassword('memberpass1')).lastInsertRowid);

  const tooSmall = await admin.post('/admin/grupe', { name: 'Grupa X', member_ids: String(ids[0]) }, '/admin/grupe');
  assert.equal(tooSmall.status, 400);

  const ok = await admin.post('/admin/grupe', { name: 'Grupa 1', member_ids: ids.map(String), notes: 'srijedom' }, '/admin/grupe');
  assert.equal(ok.status, 302);
  const group = db.prepare("SELECT * FROM training_groups WHERE name = 'Grupa 1'").get();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_group_members WHERE group_id = ?').get(group.id).n, 3);

  const dupName = await admin.post('/admin/grupe', { name: 'grupa 1', member_ids: ids.map(String) }, '/admin/grupe');
  assert.equal(dupName.status, 400);

  // Im Terminformular steht die Gruppe mit ihren Mitgliedern (für die automatische Auswahl)
  const termine = await admin.request('/admin/termine');
  assert.match(termine.text, new RegExp(`value="${group.id}" data-members="${ids.join(',')}">Grupa 1: Goran, Hana, Ilma`));

  // Bearbeiten: ein Mitglied entfernen
  await admin.post(`/admin/grupe/${group.id}`, { name: 'Grupa 1', member_ids: [String(ids[0]), String(ids[1])] }, `/admin/grupe/${group.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_group_members WHERE group_id = ?').get(group.id).n, 2);

  // Mitglieder- und Trainerseiten kennen keine Gruppenverwaltung
  const member = client();
  await member.login('goran', 'memberpass1');
  assert.equal((await member.request('/admin/grupe')).status, 403);

  await admin.post(`/admin/grupe/${group.id}/loeschen`, {}, '/admin/grupe');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_groups').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_group_members').get().n, 0);
});

test('Finansije: prihodi (uplate članova + ručno), rashodi (treneri + ručno), rezultat', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const month = '2027-01';
  const m1 = db.prepare('INSERT INTO users (name, username, email, password_hash, hourly_rate_cents) VALUES (?, ?, ?, ?, 5000)')
    .run('Jasmin', 'jasmin', 'jasmin@fin-test.de', hashPassword('memberpass1')).lastInsertRowid;
  const t = db.prepare("INSERT INTO trainers (name, rate_individual_cents, rate_group_cents) VALUES ('Fin Trener', 2000, 3000)").run().lastInsertRowid;
  // 2 × 60 min à 50 KM = 100 KM Mitgliedsbetrag; Trainer 2 × 20 KM = 40 KM
  for (const d of ['2027-01-05', '2027-01-12']) {
    db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents, trainer_id) VALUES (?, ?, '10:00', 60, 5000, ?)").run(m1, d, t);
  }
  let page = await admin.request(`/admin/finansije?monat=${month}`);
  assert.equal(page.status, 200);
  const { financeMonth } = require('../src/routes/finance');
  assert.equal(financeMonth(db, month).memberPaid, 0); // noch nicht bezahlt

  await admin.post(`/admin/abrechnung/${m1}/placeno`, { month, paid: '1' }, `/admin/abrechnung?monat=${month}`);
  await admin.post('/admin/finansije', { month, type: 'income', category: 'Profit od turnira', amount: '300', description: 'Zimski turnir' }, `/admin/finansije?monat=${month}`);
  await admin.post('/admin/finansije', { month, type: 'expense', category: 'Najam terena', amount: '150' }, `/admin/finansije?monat=${month}`);
  await admin.post('/admin/finansije', { month, type: 'expense', category: 'Loptice', amount: '45,50' }, `/admin/finansije?monat=${month}`);
  // ungültige Kategorie / Betrag werden abgelehnt
  await admin.post('/admin/finansije', { month, type: 'expense', category: 'Erfunden', amount: '10' }, `/admin/finansije?monat=${month}`);
  await admin.post('/admin/finansije', { month, type: 'expense', category: 'Struja', amount: '-5' }, `/admin/finansije?monat=${month}`);

  const f = financeMonth(db, month);
  assert.equal(f.memberPaid, 10000);
  assert.equal(f.income, 10000 + 30000);
  assert.equal(f.trainerPay, 4000);
  assert.equal(f.expense, 4000 + 15000 + 4550);
  assert.equal(f.result, 40000 - 23550);

  page = await admin.request(`/admin/finansije?monat=${month}`);
  assert.match(page.text, /Zimski turnir/);
  assert.match(page.text, /164,50\sKM/);
  assert.match(page.text, /Pregled godine 2027/);

  const entry = db.prepare("SELECT id FROM finance_entries WHERE category = 'Loptice'").get();
  await admin.post(`/admin/finansije/${entry.id}/loeschen`, {}, `/admin/finansije?monat=${month}`);
  assert.equal(financeMonth(db, month).expense, 4000 + 15000);

  // Nur Admin
  const member = client();
  await member.login('jasmin', 'memberpass1');
  assert.equal((await member.request('/admin/finansije')).status, 403);
});

test('Fester Admin aus ADMIN_EMAIL/ADMIN_PASSWORD bleibt bei jedem Start gleich', () => {
  const { openDatabase, ensureAdmin } = require('../src/db');
  const { verifyPassword } = require('../src/auth');
  const fresh = openDatabase(':memory:');
  // Vorher existiert schon ein zufällig erzeugter Admin
  assert.ok(ensureAdmin(fresh, {}));
  // Fester Admin wird zusätzlich angelegt
  assert.equal(ensureAdmin(fresh, { email: 'Chef@Schule.net', password: 'geheim-12345' }), null);
  let chef = fresh.prepare("SELECT * FROM users WHERE email = 'chef@schule.net' COLLATE NOCASE").get();
  assert.equal(chef.role, 'admin');
  assert.ok(verifyPassword('geheim-12345', chef.password_hash));
  // Passwort wurde geändert / Konto deaktiviert → nach Neustart wieder wie eingestellt
  fresh.prepare("UPDATE users SET password_hash = 'x', active = 0 WHERE id = ?").run(chef.id);
  ensureAdmin(fresh, { email: 'chef@schule.net', password: 'geheim-12345' });
  chef = fresh.prepare('SELECT * FROM users WHERE id = ?').get(chef.id);
  assert.ok(verifyPassword('geheim-12345', chef.password_hash));
  assert.equal(chef.active, 1);
  assert.equal(fresh.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'chef@schule.net' COLLATE NOCASE").get().n, 1);
});

test('Login akzeptiert versehentliche Leerzeichen um das Passwort', async () => {
  db.prepare("INSERT INTO users (name, username, email, password_hash) VALUES ('Space', 'space', 'space@test.de', ?)").run(hashPassword('mein-pw-123!?'));
  const ok = await client().login(' space ', ' mein-pw-123!? ');
  assert.equal(ok.status, 302);
  const bad = await client().login('space', 'mein-pw-123');
  assert.equal(bad.status, 401);
});

test('Startseite: Programme mit Unsplash-Fotos und lokalen Ersatzbildern, ohne Kinderbereich und ohne „2–8 igrača“', async () => {
  const home = await client().request('/');
  assert.match(home.text, /Trening po tvojoj mjeri/);
  assert.doesNotMatch(home.text, /Učimo kroz igru|Tenis za djecu/);
  assert.doesNotMatch(home.text, /2–8 igrača/);
  assert.doesNotMatch(home.text, /probni trening/i);
  for (const f of ['individualni', 'grupni', 'video-analiza', 'konsultacije']) {
    assert.match(home.text, new RegExp(`src="https://unsplash\\.com/photos/[\\w-]+/download\\?w=800" data-fallback="/static/img/illustracije/${f}\\.svg"`));
    const img = await fetch(`${base}/static/img/illustracije/${f}.svg`);
    assert.equal(img.status, 200);
  }
});

test('Admin kann eine Sicherungskopie der Datenbank herunterladen, andere nicht', async () => {
  const anon = await client().request('/admin/sigurnosna-kopija');
  assert.equal(anon.status, 302);
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const home = await admin.request('/admin');
  assert.match(home.text, /href="\/admin\/sigurnosna-kopija"/);
  const backup = await admin.request('/admin/sigurnosna-kopija');
  assert.equal(backup.status, 200);
  assert.ok(backup.text.startsWith('SQLite format 3'));
});

test('Login: Mitglieder und Trainer mit Benutzername, Admin weiterhin mit E-Mail', async () => {
  const page = await client().request('/login');
  assert.match(page.text, /Korisničko ime/);
  assert.match(page.text, /name="username"/);
  assert.doesNotMatch(page.text, /type="email"/);

  db.prepare("INSERT INTO users (name, username, email, password_hash) VALUES ('Nina', 'nina.k', 'nina@login-test.de', ?)").run(hashPassword('nina-pass-1'));
  // Mitglied: Benutzername (Groß/Klein egal) ja, E-Mail nein
  assert.equal((await client().login('Nina.K', 'nina-pass-1')).location, '/mitglied');
  assert.equal((await client().login('nina@login-test.de', 'nina-pass-1')).status, 401);
  // Admin: wie bisher mit E-Mail (auch über das alte Feld „email“)
  assert.equal((await client().login('admin@test.de', 'adminpass123')).location, '/admin');
  const c = client();
  assert.equal((await c.post('/login', { email: 'admin@test.de', password: 'adminpass123' }, '/login')).location, '/admin');

  // Admin sieht Benutzernamen in der Mitgliederliste; ungültige oder doppelte Namen werden abgelehnt
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  assert.match((await admin.request('/admin/mitglieder')).text, /nina\.k/);
  const form = { name: 'Neu', email: 'neu@login-test.de', password: 'neu-pass-12', active: '1' };
  assert.equal((await admin.post('/admin/mitglieder', { ...form, username: 'nina.K' }, '/admin/mitglieder/neu')).status, 400);
  assert.equal((await admin.post('/admin/mitglieder', { ...form, username: 'mit leerzeichen' }, '/admin/mitglieder/neu')).status, 400);
  assert.equal((await admin.post('/admin/mitglieder', { ...form, username: '' }, '/admin/mitglieder/neu')).status, 400);
  const ok = await admin.post('/admin/mitglieder', { ...form, username: 'neu_1' }, '/admin/mitglieder/neu');
  assert.equal(ok.status, 302);
  assert.equal((await client().login('neu_1', 'neu-pass-12')).location, '/mitglied');
});

test('Bestehende Datenbank: Mitglieder und Trainer erhalten automatisch Benutzernamen, Daten bleiben erhalten', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-migr-'));
  const file = path.join(dir, 'alt.db');
  try {
    // Alte Struktur (vor den Benutzernamen)
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT,
                password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
                monthly_fee_cents INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')));
              CREATE TABLE trainers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT,
                rate_individual_cents INTEGER NOT NULL DEFAULT 0, rate_group_cents INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1, notes TEXT, password_hash TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    old.prepare("INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'chef@alt.ba', 'h', 'admin')").run();
    old.prepare("INSERT INTO users (name, email, password_hash, hourly_rate_cents) VALUES ('Amra', 'amra@alt.ba', 'h', 4500)").run();
    old.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Amra Druga', 'Amra@drugi.ba', 'h')").run();
    old.prepare("INSERT INTO trainers (name, email, password_hash) VALUES ('Šaćir Đulić', NULL, 'h')").run();
    old.close();

    const migrated = openDatabase(file);
    const rows = migrated.prepare('SELECT email, username, hourly_rate_cents FROM users ORDER BY id').all();
    assert.deepEqual(rows.map((r) => [r.email, r.username]), [['chef@alt.ba', null], ['amra@alt.ba', 'amra'], ['Amra@drugi.ba', 'amra2']]);
    assert.equal(rows[1].hourly_rate_cents, 4500);
    assert.equal(migrated.prepare('SELECT username FROM trainers').get().username, 'sacir.djulic');
    migrated.close();
    // Erneutes Öffnen ändert nichts mehr
    const again = openDatabase(file);
    assert.equal(again.prepare("SELECT username FROM users WHERE email = 'amra@alt.ba'").get().username, 'amra');
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Abrechnungsart pro Monat; abgeschlossene Monate bleiben eingefroren, außer bei bewusster rückwirkender Änderung', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const id = db.prepare("INSERT INTO users (name, username, email, password_hash, hourly_rate_cents, monthly_fee_cents) VALUES ('Mona', 'mona', 'mona@monat-test.de', ?, 4000, 1000)")
    .run(hashPassword('memberpass1')).lastInsertRowid;
  const lesson = (date) => db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, ?, '10:00', 60, 4000)").run(id, date);
  lesson('2026-08-04'); lesson('2026-09-01'); lesson('2026-09-08'); lesson('2026-10-06'); lesson('2026-11-03');
  const { monthlyStatement, closeElapsedMonths } = require('../src/billing');
  const mona = () => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const page = (month) => admin.request(`/admin/abrechnung/${id}?monat=${month}`);
  const setMode = (month, mode) => admin.post(`/admin/abrechnung/${id}/nacin`, { month, billing_mode: mode }, `/admin/abrechnung/${id}?monat=${month}`);

  // Vor Monatsende: August und September werden abgeschlossen (so wie sie berechnet wurden)
  closeElapsedMonths(db, '2026-10');
  assert.equal(monthlyStatement(db, mona(), '2026-09').total, 1000 + 2 * 4000);
  assert.ok(monthlyStatement(db, mona(), '2026-09').closed);
  assert.ok(!monthlyStatement(db, mona(), '2026-10').closed);

  // Oktober manuell, November nach Plan – jeder Monat für sich
  await setMode('2026-10', 'manual');
  await admin.post(`/admin/abrechnung/${id}/posten`, { month: '2026-10', description: 'Paušal oktobar', amount: '70' }, `/admin/abrechnung/${id}?monat=2026-10`);
  assert.equal(monthlyStatement(db, mona(), '2026-10').total, 1000 + 7000);
  assert.equal(monthlyStatement(db, mona(), '2026-11').mode, 'schedule');
  assert.equal(monthlyStatement(db, mona(), '2026-11').total, 1000 + 4000);
  await setMode('2026-11', 'display');
  assert.equal(monthlyStatement(db, mona(), '2026-10').mode, 'manual');
  assert.equal(monthlyStatement(db, mona(), '2026-11').total, 1000);
  // Die Bezeichnungen der drei Arten stehen unverändert im Formular
  const oct = await page('2026-10');
  assert.match(oct.text, /Prema rasporedu \(realizovani treninzi se automatski obračunavaju\)/);
  assert.match(oct.text, /Raspored s prikazom, bez obračuna \(termini se vide, ali se ne naplaćuju\)/);
  assert.match(oct.text, /Ručni unos \(bez rasporeda – iznos unosiš kao stavke\)/);
  assert.match(oct.text, /value="manual" selected/);

  // Spätere Änderungen (Preis, Grundgebühr, Termine) verändern abgeschlossene Monate nicht
  db.prepare('UPDATE users SET monthly_fee_cents = 2500 WHERE id = ?').run(id);
  db.prepare("UPDATE lessons SET price_cents = 9999 WHERE user_id = ? AND date = '2026-09-01'").run(id);
  lesson('2026-09-15');
  assert.equal(monthlyStatement(db, mona(), '2026-09').total, 9000);
  assert.equal(monthlyStatement(db, mona(), '2026-08').total, 5000);
  let sep = await page('2026-09');
  assert.match(sep.text, /Mjesec je zaključen/);
  assert.match(sep.text, /ponovni obračun bi iznosio/);
  assert.doesNotMatch(sep.text, /Dodaj stavku/);
  // Gesperrt: keine Änderung der Art und keine Posten ohne bewusstes Öffnen
  await setMode('2026-09', 'manual');
  await admin.post(`/admin/abrechnung/${id}/posten`, { month: '2026-09', description: 'X', amount: '1' }, `/admin/abrechnung/${id}?monat=2026-09`);
  assert.equal(monthlyStatement(db, mona(), '2026-09').total, 9000);
  assert.equal(monthlyStatement(db, mona(), '2026-09').mode, 'schedule');

  // Bewusst rückwirkend ändern: öffnen, Art wählen, wieder abschließen
  await admin.post(`/admin/abrechnung/${id}/otkljucaj`, { month: '2026-09' }, `/admin/abrechnung/${id}?monat=2026-09`);
  closeElapsedMonths(db, '2026-10'); // automatisches Abschließen lässt geöffnete Monate in Ruhe
  sep = await page('2026-09');
  assert.match(sep.text, /otključan za retroaktivne izmjene/);
  await setMode('2026-09', 'manual');
  await admin.post(`/admin/abrechnung/${id}/posten`, { month: '2026-09', description: 'Korekcija', amount: '50' }, `/admin/abrechnung/${id}?monat=2026-09`);
  assert.equal(monthlyStatement(db, mona(), '2026-09').total, 2500 + 5000);
  await admin.post(`/admin/abrechnung/${id}/zakljucaj`, { month: '2026-09' }, `/admin/abrechnung/${id}?monat=2026-09`);
  db.prepare('UPDATE users SET monthly_fee_cents = 0 WHERE id = ?').run(id);
  const sepClosed = monthlyStatement(db, mona(), '2026-09');
  assert.ok(sepClosed.closed);
  assert.equal(sepClosed.total, 7500);
  assert.equal(sepClosed.mode, 'manual');
  // August blieb die ganze Zeit unverändert
  assert.equal(monthlyStatement(db, mona(), '2026-08').total, 5000);
  // Aktueller Monat kann nicht abgeschlossen werden
  await admin.post(`/admin/abrechnung/${id}/zakljucaj`, { month: '2026-10' }, `/admin/abrechnung/${id}?monat=2026-10`);
  assert.ok(!monthlyStatement(db, mona(), '2026-10').closed);

  // Mitglied sieht den eingefrorenen Betrag
  db.prepare("INSERT INTO payments (user_id, month, released) VALUES (?, '2026-09', 1)").run(id);
  const m = client();
  await m.login('mona', 'memberpass1');
  assert.match((await m.request('/mitglied/abrechnung?monat=2026-09')).text, /75,00/);
});

test('Bestehende Datenbank: bisherige Abrechnungsart bleibt für vergangene und laufende Monate erhalten', () => {
  const { monthlyStatement, closeElapsedMonths } = require('../src/billing');
  const fresh = openDatabase(':memory:');
  const id = fresh.prepare("INSERT INTO users (name, username, email, password_hash, billing_mode, monthly_fee_cents, created_at) VALUES ('Alt', 'alt', 'alt@x.ba', 'h', 'manual', 3000, '2026-07-15 10:00:00')").run().lastInsertRowid;
  fresh.prepare("INSERT INTO adjustments (user_id, month, description, amount_cents) VALUES (?, '2026-08', 'Paušal', 6000)").run(id);
  fresh.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-08-05', '10:00', 60, 4000)").run(id);
  assert.equal(closeElapsedMonths(fresh, '2026-10'), 3); // Juli, August, September
  const user = fresh.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const aug = monthlyStatement(fresh, user, '2026-08');
  assert.equal(aug.mode, 'manual');
  assert.equal(aug.total, 9000);
  assert.ok(aug.closed);
  assert.equal(monthlyStatement(fresh, user, '2026-10').mode, 'manual');
  assert.equal(closeElapsedMonths(fresh, '2026-10'), 0); // nichts doppelt
});

test('Masseneinpflege: mehrere Mitglieder auf einmal mit Benutzername und Zufallspasswort', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  // Link in „Članovi“ und Formular
  assert.match((await admin.request('/admin/mitglieder')).text, /href="\/admin\/mitglieder\/vise"[^>]*>[^<]*Dodaj više članova/);
  const form = await admin.request('/admin/mitglieder/vise');
  assert.equal(form.status, 200);
  assert.match(form.text, /<textarea name="lines"/);

  // Ein Trainer belegt bereits „ana.maric“ → das Mitglied bekommt einen anderen Namen
  db.prepare("INSERT INTO trainers (name, username) VALUES ('Ana Trener', 'ana.maric')").run();
  const before = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member'").get().n;
  const res = await admin.post('/admin/mitglieder/vise', {
    lines: 'Emir, Hadžić\r\nAna Marić\n\n   Emir ,  Hadžić  \nĐuro; Šarić\n',
  }, '/admin/mitglieder/vise');
  assert.equal(res.status, 200);
  const created = db.prepare("SELECT * FROM users WHERE role = 'member' ORDER BY id DESC LIMIT 4").all().reverse();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member'").get().n, before + 4);
  assert.deepEqual(created.map((u) => u.name), ['Emir Hadžić', 'Ana Marić', 'Emir Hadžić', 'Đuro Šarić']);
  assert.deepEqual(created.map((u) => u.username), ['emir.hadzic', 'ana.maric2', 'emir.hadzic2', 'djuro.saric']);
  assert.ok(created.every((u) => u.active === 1 && u.role === 'member'));

  // Übersicht: Name, Benutzername und Passwort im Klartext – gespeichert wird nur der Hash
  const rows = [...res.text.matchAll(/<tr class="bulk-row"><td>([^<]+)<\/td><td><code>([^<]+)<\/code><\/td><td><code>([^<]+)<\/code><\/td><\/tr>/g)];
  assert.equal(rows.length, 4);
  const { verifyPassword } = require('../src/auth');
  const passwords = new Set();
  for (const [, name, username, password] of rows) {
    const u = created.find((x) => x.username === username);
    assert.ok(u, username);
    assert.equal(u.name, name);
    assert.match(password, /^[A-Z][a-z]{4,}\d{3}$/); // gut lesbar: Wort + Ziffern, z. B. „Teren482“
    assert.notEqual(u.password_hash, password);
    assert.ok(verifyPassword(password, u.password_hash));
    passwords.add(password);
  }
  assert.equal(passwords.size, 4);
  // Anmeldung mit den angezeigten Zugangsdaten funktioniert
  const [, , firstUser, firstPw] = rows[0];
  assert.equal((await client().login(firstUser, firstPw)).location, '/mitglied');

  // Ungültige Zeile (nur ein Name) → nichts wird angelegt, Fehler mit Zeilennummer
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const bad = await admin.post('/admin/mitglieder/vise', { lines: 'Mirza, Begić\nSamoime\n' }, '/admin/mitglieder/vise');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Red 2/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, count);
  const empty = await admin.post('/admin/mitglieder/vise', { lines: '  \n ' }, '/admin/mitglieder/vise');
  assert.equal(empty.status, 400);

  // Nur für Admins
  const member = client();
  await member.login(firstUser, firstPw);
  assert.equal((await member.request('/admin/mitglieder/vise')).status, 403);
  assert.equal((await member.post('/admin/mitglieder/vise', { lines: 'X, Y' }, '/mitglied')).status, 403);

  // Einzelnes Anlegen funktioniert weiterhin wie bisher
  const single = await admin.post('/admin/mitglieder', {
    name: 'Jedan Član', username: 'jedan', email: 'jedan@bulk-test.de', password: 'jedan-pass-1', active: '1',
  }, '/admin/mitglieder/neu');
  assert.equal(single.status, 302);
});

// Hilfsfunktion: Mitglied direkt anlegen
function makeMember(name, username, { fee = 0, rate = 4000 } = {}) {
  return db.prepare('INSERT INTO users (name, username, email, password_hash, hourly_rate_cents, monthly_fee_cents) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, username, `${username}@kids-test.de`, hashPassword('memberpass1'), rate, fee).lastInsertRowid;
}

test('Kinder-Konten: Elternteil legt an, setzt Passwort zurück, löscht; Kind meldet sich an und sieht nur seinen Plan', async () => {
  const parentId = makeMember('Roditelj Jedan', 'roditelj1', { fee: 2000 });
  const parent = client();
  assert.equal((await parent.login('roditelj1', 'memberpass1')).location, '/mitglied');
  // Der Elternbereich bleibt wie bisher (Monatsbetrag sichtbar) und hat zusätzlich „Djeca“
  const home = await parent.request('/mitglied');
  assert.match(home.text, /Iznos za/);
  assert.match(home.text, /href="\/mitglied\/djeca"/);
  assert.equal((await parent.request('/mitglied/djeca')).status, 200);

  // Anlegen: ungültig / doppelt / gültig
  assert.equal((await parent.post('/mitglied/djeca', { name: 'Dijete', username: 'x', password: 'dijete-pass1' }, '/mitglied/djeca')).status, 400);
  assert.equal((await parent.post('/mitglied/djeca', { name: 'Dijete', username: 'roditelj1', password: 'dijete-pass1' }, '/mitglied/djeca')).status, 400);
  assert.equal((await parent.post('/mitglied/djeca', { name: 'Dijete', username: 'dijete.jedan', password: 'kratko' }, '/mitglied/djeca')).status, 400);
  const ok = await parent.post('/mitglied/djeca', { name: 'Dino Jedan', username: 'Dijete.Jedan', password: 'dijete-pass1' }, '/mitglied/djeca');
  assert.equal(ok.status, 302);
  const kid = db.prepare("SELECT * FROM users WHERE username = 'dijete.jedan'").get();
  assert.equal(kid.parent_id, parentId);
  assert.equal(kid.role, 'member');
  assert.notEqual(kid.password_hash, 'dijete-pass1');
  assert.match((await parent.request('/mitglied/djeca')).text, /Dino Jedan[\s\S]*dijete\.jedan/);

  // Termine: Kind hat eigenes Training, Elternteil eigenes
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-06', '15:00', 60, 3000)").run(kid.id);
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-07', '19:00', 60, 4000)").run(parentId);

  // Kind meldet sich an und sieht nur seinen Wochenplan
  const child = client();
  assert.equal((await child.login('dijete.jedan', 'dijete-pass1')).location, '/mitglied');
  const plan = await child.request('/mitglied?woche=2026-10-05');
  assert.equal(plan.status, 200);
  assert.match(plan.text, /15:00–16:00/);
  assert.doesNotMatch(plan.text, /19:00–20:00/); // nicht der Plan des Elternteils
  assert.match(plan.text, /href="\/mitglied\?woche=2026-09-28"/); // Wochen-Navigation

  // Passwort zurücksetzen
  assert.equal((await parent.post(`/mitglied/djeca/${kid.id}/lozinka`, { password: 'novo-pass-22' }, '/mitglied/djeca')).status, 302);
  assert.equal((await client().login('dijete.jedan', 'dijete-pass1')).status, 401);
  assert.equal((await client().login('dijete.jedan', 'novo-pass-22')).location, '/mitglied');

  // Löschen
  assert.equal((await parent.post(`/mitglied/djeca/${kid.id}/obrisi`, {}, '/mitglied/djeca')).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(kid.id).n, 0);
  assert.equal((await client().login('dijete.jedan', 'novo-pass-22')).status, 401);
  assert.equal((await child.request('/mitglied')).status, 302); // Sitzung des gelöschten Kindes ist ungültig
  // Elternteil bleibt unverändert
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(parentId).n, 1);
});

test('Kind-Konto hat keinerlei Zugriff auf Finanzen (Beträge, Zahlungen, Abrechnung)', async () => {
  const parentId = makeMember('Roditelj Dva', 'roditelj2', { fee: 2500 });
  const parent = client();
  await parent.login('roditelj2', 'memberpass1');
  await parent.post('/mitglied/djeca', { name: 'Lana Dva', username: 'lana.dva', password: 'lana-pass-1' }, '/mitglied/djeca');
  const kid = db.prepare("SELECT * FROM users WHERE username = 'lana.dva'").get();
  // Admin hat Beträge, Zahlungen und Freigaben für Kind und Elternteil erfasst
  db.prepare('UPDATE users SET hourly_rate_cents = 3700, monthly_fee_cents = 1100 WHERE id = ?').run(kid.id);
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-08', '16:00', 60, 3700)").run(kid.id);
  db.prepare("INSERT INTO adjustments (user_id, month, description, amount_cents) VALUES (?, '2026-10', 'Tajna stavka', 999)").run(kid.id);
  db.prepare("INSERT INTO payments (user_id, month, paid, paid_at, released) VALUES (?, '2026-10', 1, '2026-10-05', 1)").run(kid.id);
  db.prepare("INSERT INTO payments (user_id, month, paid, paid_at, released) VALUES (?, '2026-10', 1, '2026-10-05', 1)").run(parentId);
  db.prepare("INSERT INTO adjustments (user_id, month, description, amount_cents) VALUES (?, '2026-10', 'Roditeljska stavka', 777)").run(parentId);

  const child = client();
  await child.login('lana.dva', 'lana-pass-1');
  const home = await child.request('/mitglied?woche=2026-10-05');
  assert.equal(home.status, 200);
  assert.match(home.text, /16:00–17:00/);
  for (const re of [/KM/, /Iznos/i, /Obračun/i, /plaćen/i, /\/mitglied\/abrechnung/, /\/mitglied\/djeca/, /Aktuelnosti/, /37,00|11,00|9,99|7,77|25,00/]) {
    assert.doesNotMatch(home.text, re, `Kind sieht ${re}`);
  }
  // Alle Finanz- und Verwaltungsseiten gesperrt (auch mit Parametern / per POST)
  for (const path of ['/mitglied/abrechnung', '/mitglied/abrechnung?monat=2026-10', '/mitglied/djeca', '/mitglied/aktuelnosti', '/mitglied/passwort',
    '/admin', '/admin/abrechnung', '/admin/finansije', '/trener']) {
    const r = await child.request(path);
    assert.ok(r.status === 403 || r.status === 302, `${path}: ${r.status}`);
    assert.doesNotMatch(r.text, /Tajna stavka|Roditeljska stavka|KM/);
  }
  const token = await child.csrf('/mitglied');
  assert.equal((await child.request('/mitglied/djeca', { method: 'POST', form: { _csrf: token, name: 'X Y', username: 'xy.kid', password: 'xy-pass-123' } })).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'xy.kid'").get().n, 0);
  // Fremde Wochen (z. B. die des Elternteils) gibt es für das Kind nicht – nur eigene Termine
  assert.doesNotMatch((await child.request('/mitglied?woche=2026-10-05')).text, /Roditelj Dva/);
});

test('Ein Mitglied sieht niemals Daten oder Kinder-Konten eines anderen Mitglieds', async () => {
  const aId = makeMember('Alma Prva', 'alma.prva', { fee: 1500 });
  const bId = makeMember('Bojan Drugi', 'bojan.drugi', { fee: 8800 });
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-06', '11:00', 60, 4000)").run(aId);
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-06', '13:00', 90, 6600)").run(bId);
  db.prepare("INSERT INTO adjustments (user_id, month, description, amount_cents) VALUES (?, '2026-10', 'Bojanova stavka', 1234)").run(bId);
  db.prepare("INSERT INTO payments (user_id, month, released) VALUES (?, '2026-10', 1)").run(aId);
  db.prepare("INSERT INTO payments (user_id, month, released) VALUES (?, '2026-10', 1)").run(bId);

  const a = client();
  await a.login('alma.prva', 'memberpass1');
  const b = client();
  await b.login('bojan.drugi', 'memberpass1');
  await b.post('/mitglied/djeca', { name: 'Bojanovo Dijete', username: 'bojan.kid', password: 'bojan-kid-1' }, '/mitglied/djeca');
  const bKid = db.prepare("SELECT * FROM users WHERE username = 'bojan.kid'").get();
  assert.equal(bKid.parent_id, bId);

  // A sieht nur eigene Termine, Beträge und Kinder
  const pages = [
    await a.request('/mitglied?woche=2026-10-05'),
    await a.request('/mitglied/abrechnung?monat=2026-10'),
    await a.request('/mitglied/djeca'),
    // Versuch, fremde Daten über Parameter zu erreichen
    await a.request(`/mitglied/abrechnung?monat=2026-10&user=${bId}&id=${bId}`),
    await a.request(`/mitglied?woche=2026-10-05&user_id=${bId}`),
  ];
  for (const p of pages) {
    assert.doesNotMatch(p.text, /Bojan|bojan|13:00–14:30|Bojanova stavka|12,34|88,00|66,00/);
  }
  assert.match(pages[0].text, /11:00–12:00/);
  assert.match(pages[1].text, /55,00/); // 15 KM + 40 KM – nur Almas eigener Betrag

  // Fremdes Kind: weder Passwort zurücksetzen noch löschen möglich
  const hashBefore = bKid.password_hash;
  assert.equal((await a.post(`/mitglied/djeca/${bKid.id}/lozinka`, { password: 'gehackt-123' }, '/mitglied/djeca')).status, 404);
  assert.equal((await a.post(`/mitglied/djeca/${bKid.id}/obrisi`, {}, '/mitglied/djeca')).status, 404);
  // Auch das andere Mitglied selbst lässt sich nicht als „Kind“ ansprechen
  assert.equal((await a.post(`/mitglied/djeca/${bId}/lozinka`, { password: 'gehackt-123' }, '/mitglied/djeca')).status, 404);
  assert.equal((await a.post(`/mitglied/djeca/${bId}/obrisi`, {}, '/mitglied/djeca')).status, 404);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(bKid.id).password_hash, hashBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?)').get(bKid.id, bId).n, 2);
  assert.equal((await client().login('bojan.kid', 'gehackt-123')).status, 401);
  assert.equal((await client().login('bojan.drugi', 'gehackt-123')).status, 401);

  // Kind von B sieht nur sich, nicht B
  const kid = client();
  await kid.login('bojan.kid', 'bojan-kid-1');
  assert.doesNotMatch((await kid.request('/mitglied?woche=2026-10-05')).text, /13:00–14:30|11:00–12:00/);

  // Admin sieht weiterhin alle Mitglieder inkl. Kind, mit Hinweis auf Elternteil
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const list = await admin.request('/admin/mitglieder');
  assert.match(list.text, /Bojanovo Dijete[\s\S]*dijete · roditelj: Bojan Drugi/);
});

test('Kinder-Konten: genau ein Kind-Konto pro Mitglied, fest für alle (auch nicht durch den Admin erweiterbar)', async () => {
  const parentId = makeMember('Roditelj Limit', 'roditelj.limit');
  const parent = client();
  await parent.login('roditelj.limit', 'memberpass1');
  const add = (username, extra = {}) => parent.post('/mitglied/djeca', { name: `Dijete ${username}`, username, password: 'dijete-pass1', ...extra }, '/mitglied/djeca');
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM users WHERE parent_id = ?').get(parentId).n;

  // Ohne Kind wird das Formular angeboten
  assert.match((await parent.request('/mitglied/djeca')).text, /<form method="post" action="\/mitglied\/djeca" /);
  assert.equal((await add('limit.kid1')).status, 302);
  assert.equal(count(), 1);

  // Zweites Kind: abgelehnt, freundlicher Hinweis, nichts angelegt
  const second = await add('limit.kid2');
  assert.equal(second.status, 400);
  assert.match(second.text, /najviše jedan dječiji račun/);
  assert.equal(count(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'limit.kid2'").get().n, 0);
  // Formular wird nicht mehr angeboten, nur der Hinweis; das bestehende Kind bleibt verwaltbar
  const page = await parent.request('/mitglied/djeca');
  assert.match(page.text, /najviše jedan dječiji račun/);
  assert.doesNotMatch(page.text, /<form method="post" action="\/mitglied\/djeca" /);
  assert.match(page.text, /limit\.kid1/);

  // Auch mit manipuliertem Formular (Limit-Feld) nicht umgehbar
  assert.equal((await add('limit.kid3', { children_limit: '5', limit: '5' })).status, 400);
  assert.equal(count(), 1);

  // Der Admin kann das Limit nicht erhöhen: kein Feld im Formular, ein mitgeschicktes Feld wirkt nicht
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  assert.doesNotMatch((await admin.request(`/admin/mitglieder/${parentId}`)).text, /children_limit|dječijih računa/);
  await admin.post(`/admin/mitglieder/${parentId}`, {
    name: 'Roditelj Limit', username: 'roditelj.limit', email: 'roditelj.limit@kids-test.de', active: '1', children_limit: '5',
  }, `/admin/mitglieder/${parentId}`);
  db.prepare('UPDATE users SET children_limit = 5 WHERE id = ?').run(parentId); // auch ein alter Wert in der Datenbank zählt nicht
  assert.equal((await add('limit.kid4')).status, 400);
  assert.equal(count(), 1);

  // Nach dem Löschen des Kindes kann wieder genau eines angelegt werden
  const kid1 = db.prepare("SELECT id FROM users WHERE username = 'limit.kid1'").get().id;
  await parent.post(`/mitglied/djeca/${kid1}/obrisi`, {}, '/mitglied/djeca');
  assert.equal(count(), 0);
  assert.equal((await add('limit.kid5')).status, 302);
  assert.equal((await add('limit.kid6')).status, 400);
  assert.equal(count(), 1);

  // Das Limit gilt für jedes Mitglied einzeln
  const other = makeMember('Drugi Limit', 'drugi.limit');
  const o = client();
  await o.login('drugi.limit', 'memberpass1');
  assert.equal((await o.post('/mitglied/djeca', { name: 'Drugo Dijete', username: 'drugi.kid', password: 'dijete-pass1' }, '/mitglied/djeca')).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE parent_id = ?').get(other).n, 1);
});

// Uhr vorübergehend auf einen Zeitpunkt stellen (danach wieder auf den festen Testzeitpunkt).
async function atTime(iso, fn) {
  mock.timers.setTime(new Date(iso).getTime());
  try {
    return await fn();
  } finally {
    mock.timers.setTime(new Date('2026-10-09T10:00:00').getTime());
  }
}

test('Wochenfreigabe: Zeitpunkt ist Sonntag vor der Woche, 17 Uhr Sarajevo (Sommer- und Winterzeit)', () => {
  const { autoReleaseAt } = require('../src/weeks');
  assert.equal(new Date(autoReleaseAt('2026-10-19')).toISOString(), '2026-10-18T15:00:00.000Z'); // CEST (+2)
  assert.equal(new Date(autoReleaseAt('2026-10-26')).toISOString(), '2026-10-25T16:00:00.000Z'); // Zeitumstellung am 25.10. → CET (+1)
  assert.equal(new Date(autoReleaseAt('2027-01-04')).toISOString(), '2027-01-03T16:00:00.000Z');
  assert.equal(new Date(autoReleaseAt('2027-03-29')).toISOString(), '2027-03-28T15:00:00.000Z'); // Sommerzeit seit 28.3.
});

test('Wochenfreigabe: kommende Woche ist versteckt und wird am Sonntag um 17 Uhr automatisch freigegeben', async () => {
  const id = makeMember('Sedmica Auto', 'sedmica.auto');
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-21', '08:15', 60, 4000)").run(id);
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-07', '07:45', 60, 4000)").run(id);
  const parent = client();
  await parent.login('sedmica.auto', 'memberpass1');
  await parent.post('/mitglied/djeca', { name: 'Auto Dijete', username: 'sedmica.kid', password: 'kid-pass-123' }, '/mitglied/djeca');
  const kidId = db.prepare("SELECT id FROM users WHERE username = 'sedmica.kid'").get().id;
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-22', '09:30', 60, 0)").run(kidId);

  // Laufende Woche ist sichtbar (bestehende Daten bleiben sichtbar)
  assert.match((await parent.request('/mitglied?woche=2026-10-05')).text, /07:45–08:45/);
  // Kommende Woche (19.–25.10.) ist versteckt – auch nicht in „Sljedeći termini“
  let week = await parent.request('/mitglied?woche=2026-10-19');
  assert.equal(week.status, 200);
  assert.doesNotMatch(week.text, /08:15/);
  assert.match(week.text, /još nije objavljen/);
  assert.doesNotMatch((await parent.request('/mitglied')).text, /08:15/);

  // Admin sieht die Woche immer, mit Status „versteckt“ und automatischer Freigabe
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const adminWeek = await admin.request('/admin/termine?woche=2026-10-19');
  assert.match(adminWeek.text, /08:15/);
  assert.match(adminWeek.text, /Skrivena/);
  assert.match(adminWeek.text, /automatski u nedjelju 18\.10\.2026\. u 17:00/);

  // Sonntag 16:59 Sarajevo → noch versteckt; 17:00 → freigegeben (Mitglied und Kind)
  await atTime('2026-10-18T16:59:00+02:00', async () => {
    const p = client();
    await p.login('sedmica.auto', 'memberpass1');
    assert.doesNotMatch((await p.request('/mitglied?woche=2026-10-19')).text, /08:15/);
    const k = client();
    await k.login('sedmica.kid', 'kid-pass-123');
    assert.doesNotMatch((await k.request('/mitglied?woche=2026-10-19')).text, /09:30/);
  });
  await atTime('2026-10-18T17:00:00+02:00', async () => {
    const p = client();
    await p.login('sedmica.auto', 'memberpass1');
    const visible = await p.request('/mitglied?woche=2026-10-19');
    assert.match(visible.text, /08:15–09:15/);
    assert.doesNotMatch(visible.text, /09:30/); // nur eigene Termine, nicht die des Kindes
    assert.match((await p.request('/mitglied')).text, /08:15/); // jetzt auch in „Sljedeći termini“
    const k = client();
    await k.login('sedmica.kid', 'kid-pass-123');
    const kidWeek = await k.request('/mitglied?woche=2026-10-19');
    assert.match(kidWeek.text, /09:30–10:30/);
    assert.doesNotMatch(kidWeek.text, /08:15/);
    const a = client();
    await a.login('admin@test.de', 'adminpass123');
    assert.match((await a.request('/admin/termine?woche=2026-10-19')).text, /Objavljena/);
  });
  // Die automatische Freigabe ist gespeichert: auch zurück vor Sonntag bleibt die Woche freigegeben
  assert.match((await parent.request('/mitglied?woche=2026-10-19')).text, /08:15–09:15/);
});

test('Wochenfreigabe: automatische Freigabe pro Woche ausschalten; manuelle Freigabe und Verstecken', async () => {
  const id = makeMember('Sedmica Rucno', 'sedmica.rucno');
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-10-27', '18:10', 60, 4000)").run(id);
  db.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, '2026-11-03', '18:20', 60, 4000)").run(id);
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const back = '/admin/termine?woche=2026-10-26';

  // Auto-Freigabe für die Woche 26.10. ausschalten – nur für diese Woche
  assert.equal((await admin.post('/admin/termine/sedmica/auto', { monday: '2026-10-26', auto: '0' }, back)).status, 302);
  assert.match((await admin.request(back)).text, /Automatska objava je isključena/);
  const { weekStatus } = require('../src/weeks');
  assert.equal(weekStatus(db, '2026-11-02').auto, true); // andere Wochen unverändert

  // Sonntag 25.10. 17:00 (Winterzeit) und auch Tage später: bleibt versteckt
  for (const t of ['2026-10-25T17:00:00+01:00', '2026-10-25T23:00:00+01:00', '2026-10-28T12:00:00+01:00']) {
    await atTime(t, async () => {
      const m = client();
      await m.login('sedmica.rucno', 'memberpass1');
      const w = await m.request('/mitglied?woche=2026-10-26');
      assert.doesNotMatch(w.text, /18:10/, t);
      assert.match(w.text, /još nije objavljen/);
    });
  }
  // Die Folgewoche (Auto-Freigabe aktiv) erscheint am Sonntag 1.11. um 17 Uhr ganz normal
  assert.equal(weekStatus(db, '2026-11-02', new Date('2026-11-01T16:00:00Z').getTime()).released, true);

  // Admin gibt die Woche von Hand frei → sofort sichtbar
  assert.equal((await admin.post('/admin/termine/sedmica/objavi', { monday: '2026-10-26' }, back)).status, 302);
  const m = client();
  await m.login('sedmica.rucno', 'memberpass1');
  assert.match((await m.request('/mitglied?woche=2026-10-26')).text, /18:10–19:10/);
  assert.match((await admin.request(back)).text, /Objavljena/);

  // Admin kann eine Woche jederzeit vor Sonntag manuell freigeben und wieder verstecken
  const back2 = '/admin/termine?woche=2026-11-02';
  await admin.post('/admin/termine/sedmica/objavi', { monday: '2026-11-02' }, back2);
  assert.match((await m.request('/mitglied?woche=2026-11-02')).text, /18:20–19:20/);
  await admin.post('/admin/termine/sedmica/sakrij', { monday: '2026-11-02' }, back2);
  assert.doesNotMatch((await m.request('/mitglied?woche=2026-11-02')).text, /18:20/);
  // Auto-Freigabe wieder einschalten ändert nichts an der versteckten Woche vor Sonntag
  await admin.post('/admin/termine/sedmica/auto', { monday: '2026-11-02', auto: '1' }, back2);
  assert.doesNotMatch((await m.request('/mitglied?woche=2026-11-02')).text, /18:20/);

  // Ungültige Eingaben / Nicht-Admins
  assert.equal((await admin.post('/admin/termine/sedmica/objavi', { monday: '2026-10-27' }, back)).status, 400); // kein Montag
  assert.equal((await m.post('/admin/termine/sedmica/objavi', { monday: '2026-11-02' }, '/mitglied')).status, 403);
  assert.doesNotMatch((await m.request('/mitglied?woche=2026-11-02')).text, /18:20/);
});

test('Startseite deaktiviert (Standard): bettertennis.net leitet direkt zum Login, Startseite bleibt per Schalter aktivierbar', async () => {
  const fresh = openDatabase(':memory:');
  ensureAdmin(fresh, { email: 'chef@start.test', password: 'chefpass123' });
  fresh.prepare("INSERT INTO users (name, username, email, password_hash) VALUES ('Start Član', 'start.clan', 'start@x.ba', ?)").run(hashPassword('memberpass1'));
  const app = createApp(fresh, { secret: 'start-secret' }); // ohne Option = wie in Produktion ohne PUBLIC_HOMEPAGE
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    // Anonym: / → /login (temporäre Umleitung, damit die Startseite später wieder aktiviert werden kann)
    const root = await fetch(`${url}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login');
    // Login-Seite ohne Verweise auf die Startseite / Anmeldung für Interessenten
    const login = await (await fetch(`${url}/login`)).text();
    assert.match(login, /Korisničko ime/);
    assert.doesNotMatch(login, /href="\/#anmeldung"|>Početna</);
    assert.doesNotMatch(login, /hero-photo|Trening po tvojoj mjeri/);

    // Login funktioniert unverändert; eingeloggt führt / zur eigenen Startseite
    const page = await fetch(`${url}/login`);
    const cookie = page.headers.get('set-cookie').split(';')[0];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())[1];
    const res = await fetch(`${url}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, username: 'start.clan', password: 'memberpass1' }).toString(),
    });
    assert.equal(res.headers.get('location'), '/mitglied');
    const session = res.headers.get('set-cookie').split(';')[0];
    const home = await fetch(`${url}/`, { redirect: 'manual', headers: { cookie: session } });
    assert.equal(home.headers.get('location'), '/mitglied');
    // Statische Dateien (Logo, CSS) weiterhin erreichbar
    assert.equal((await fetch(`${url}/static/img/logo.png`)).status, 200);
  } finally {
    srv.close();
  }
  // Mit Schalter ist die bisherige Startseite unverändert da
  assert.match((await client().request('/')).text, /Trening po tvojoj mjeri/);
});

test('Lesbare Zufallspasswörter: Wort + drei Ziffern, ohne Sonderzeichen, zufällig und unterschiedlich', async () => {
  const { readablePassword, PASSWORD_WORDS } = require('../src/auth');
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const pw = readablePassword();
    assert.match(pw, /^[A-Z][a-z]{4,}\d{3}$/, pw);
    assert.ok(pw.length >= 8, pw); // erfüllt die Mindestlänge für Passwörter
    seen.add(pw);
  }
  assert.ok(seen.size > 450, `zu wenig verschiedene Passwörter: ${seen.size}`);
  assert.ok(PASSWORD_WORDS.length >= 40);
  assert.ok(PASSWORD_WORDS.every((w) => /^[A-Z][a-z]{4,}$/.test(w)), 'nur Wörter ohne Kvačice/Sonderzeichen');
  // Auch das Formular „Novi član“ schlägt ein lesbares Passwort vor
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const form = await admin.request('/admin/mitglieder/neu');
  assert.match(form.text, /name="password" type="text"[^>]*value="[A-Z][a-z]{4,}\d{3}"/);
  // Innerhalb einer Massenanlage ist jedes Passwort verschieden
  const lines = Array.from({ length: 30 }, (_, i) => `Lozinka${String.fromCharCode(97 + (i % 26))}, Test${i}`).join('\n');
  const res = await admin.post('/admin/mitglieder/vise', { lines }, '/admin/mitglieder/vise');
  const pws = [...res.text.matchAll(/<tr class="bulk-row"><td>[^<]+<\/td><td><code>[^<]+<\/code><\/td><td><code>([^<]+)<\/code>/g)].map((m) => m[1]);
  assert.equal(pws.length, 30);
  assert.equal(new Set(pws).size, 30);
});

// ---------------------------------------------------------------- Elternkonten
// Gemeinsame Testdaten: drei Spieler einer Familie, ein fremdes Mitglied.
function setupFamily(prefix) {
  const p1 = makeMember(`${prefix} Prvi`, `${prefix}.prvi`, { fee: 1000 });
  const p2 = makeMember(`${prefix} Drugi`, `${prefix}.drugi`);
  const p3 = makeMember(`${prefix} Treci`, `${prefix}.treci`);
  const stranger = makeMember(`${prefix} Stranac`, `${prefix}.stranac`, { fee: 9900 });
  const lesson = (uid, date, time, price) => db.prepare(
    "INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (?, ?, ?, 60, ?)"
  ).run(uid, date, time, price);
  lesson(p1, '2026-10-06', '10:05', 4000);
  lesson(p3, '2026-10-07', '11:05', 3000);
  lesson(stranger, '2026-10-06', '12:05', 7700);
  lesson(p1, '2026-09-15', '10:05', 4000);
  lesson(p3, '2026-11-17', '11:05', 3000);
  db.prepare("INSERT INTO adjustments (user_id, month, description, amount_cents) VALUES (?, '2026-10', 'Paušal', 2500)").run(p2);
  for (const uid of [p1, p2, p3, stranger]) {
    for (const month of ['2026-09', '2026-10', '2026-11']) {
      db.prepare('INSERT OR IGNORE INTO payments (user_id, month, released) VALUES (?, ?, 1)').run(uid, month);
    }
  }
  return { p1, p2, p3, stranger };
}

async function createParentAccount(admin, { name, username, password, players }) {
  return admin.post('/admin/roditelji', { name, username, password, player_ids: players.map(String), active: '1' }, '/admin/roditelji/novi');
}

test('Elternkonto: Admin legt an (Benutzername, Passwort, Spieler-Auswahl), Login zeigt gebündelten Wochenplan', async () => {
  const { p1, p2, p3, stranger } = setupFamily('obitelj');
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  // Formular mit Auswahl der bestehenden Mitglieds-Konten
  const form = await admin.request('/admin/roditelji/novi');
  assert.equal(form.status, 200);
  assert.match(form.text, new RegExp(`name="player_ids" value="${p1}"`));
  assert.match(form.text, /name="password" type="text"[^>]*value="[A-Z][a-z]{4,}\d{3}"/);
  // Ungültig: keine Spieler / Benutzername vergeben / zu kurzes Passwort
  assert.equal((await createParentAccount(admin, { name: 'R', username: 'roditelj.a', password: 'roditelj-1', players: [] })).status, 400);
  assert.equal((await createParentAccount(admin, { name: 'R', username: 'obitelj.prvi', password: 'roditelj-1', players: [p1] })).status, 400);
  assert.equal((await createParentAccount(admin, { name: 'R', username: 'roditelj.a', password: 'kurz', players: [p1] })).status, 400);
  const ok = await createParentAccount(admin, { name: 'Roditelj Obitelj', username: 'Roditelj.A', password: 'roditelj-1', players: [p1, p2, p3] });
  assert.equal(ok.status, 302);
  const acc = db.prepare("SELECT * FROM parent_accounts WHERE username = 'roditelj.a'").get();
  assert.ok(acc);
  assert.notEqual(acc.password_hash, 'roditelj-1');
  assert.deepEqual(db.prepare('SELECT user_id FROM parent_account_players WHERE parent_account_id = ? ORDER BY user_id').all(acc.id).map((r) => r.user_id), [p1, p2, p3]);
  assert.match((await admin.request('/admin/roditelji')).text, /Roditelj Obitelj[\s\S]*obitelj Prvi/i);
  // Benutzernamen bleiben eindeutig über alle Kontoarten
  const dupMember = await admin.post('/admin/mitglieder', { name: 'X', username: 'roditelj.a', email: 'x@dup-parent.de', password: 'xxxx-pass-1', active: '1' }, '/admin/mitglieder/neu');
  assert.equal(dupMember.status, 400);

  // Login mit dem Elternkonto → gebündelter Wochenplan aller zugeordneten Spieler
  const parent = client();
  const login = await parent.login('roditelj.a', 'roditelj-1');
  assert.equal(login.location, '/roditelj');
  const week = await parent.request('/roditelj?woche=2026-10-05');
  assert.equal(week.status, 200);
  assert.match(week.text, /10:05–11:05/);
  assert.match(week.text, /11:05–12:05/);
  assert.match(week.text, /obitelj Prvi/);
  assert.match(week.text, /obitelj Treci/);
  assert.doesNotMatch(week.text, /12:05–13:05|Stranac/);
  // Versteckte (noch nicht freigegebene) Woche ist auch für das Elternkonto unsichtbar
  const hidden = await parent.request('/roditelj?woche=2026-11-16');
  assert.doesNotMatch(hidden.text, /11:05/);
  assert.match(hidden.text, /još nije objavljen/);
  // Bisherige Konten unverändert: Spieler loggt sich normal ein und sieht seinen eigenen Bereich
  const player = client();
  assert.equal((await player.login('obitelj.prvi', 'memberpass1')).location, '/mitglied');
  assert.match((await player.request('/mitglied/abrechnung?monat=2026-10')).text, /50,00/);
  // Deaktiviertes Elternkonto kann sich nicht anmelden
  db.prepare('UPDATE parent_accounts SET active = 0 WHERE id = ?').run(acc.id);
  assert.equal((await client().login('roditelj.a', 'roditelj-1')).status, 401);
  assert.equal((await parent.request('/roditelj')).status, 302);
  db.prepare('UPDATE parent_accounts SET active = 1 WHERE id = ?').run(acc.id);
  assert.ok(stranger);
});

// Liest die angezeigte Summe der ausgewählten Spieler aus der Seite.
function selectedTotal(text) {
  const m = /data-total="(-?\d+)"/.exec(text);
  assert.ok(m, 'Summe nicht gefunden');
  return Number(m[1]);
}

test('Elternkonto: Monats-Summe der frei ausgewählten Spieler wird korrekt und live zusammengerechnet', async () => {
  const { p1, p2, p3, stranger } = setupFamily('suma');
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  await createParentAccount(admin, { name: 'Roditelj Suma', username: 'roditelj.suma', password: 'roditelj-1', players: [p1, p2, p3] });
  const parent = client();
  await parent.login('roditelj.suma', 'roditelj-1');
  const fin = (month, ids) => parent.request(`/roditelj/finansije?monat=${month}${ids === undefined ? '' : `&izbor=1${ids.map((i) => `&igraci=${i}`).join('')}`}`);

  // Oktober: P1 = 10 + 40 = 50 KM, P2 = 25 KM (Posten), P3 = 30 KM
  let r = await fin('2026-10');
  assert.equal(r.status, 200);
  assert.equal(selectedTotal(r.text), 10500); // ohne Auswahl: alle zugeordneten Spieler
  assert.match(r.text, /105,00/);
  assert.equal(selectedTotal((await fin('2026-10', [p1, p3])).text), 8000);
  assert.equal(selectedTotal((await fin('2026-10', [p2])).text), 2500);
  assert.equal(selectedTotal((await fin('2026-10', [p1])).text), 5000);
  assert.equal(selectedTotal((await fin('2026-10', [p2, p3])).text), 5500);
  assert.equal(selectedTotal((await fin('2026-10', [p1, p2, p3])).text), 10500);
  const none = await fin('2026-10', []);
  assert.equal(selectedTotal(none.text), 0);
  assert.match(none.text, /Nijedan igrač nije odabran/);
  // Die Auswahl wird nicht gespeichert: ohne Parameter wieder alle
  assert.equal(selectedTotal((await fin('2026-10')).text), 10500);
  // Häkchen spiegeln die aktuelle Auswahl, Monatsnavigation behält sie (nur in der URL)
  r = await fin('2026-10', [p1, p3]);
  assert.match(r.text, new RegExp(`name="igraci" value="${p1}" checked`));
  assert.doesNotMatch(r.text, new RegExp(`name="igraci" value="${p2}" checked`));
  assert.match(r.text, new RegExp(`href="/roditelj/finansije\\?monat=2026-09&amp;izbor=1&amp;igraci=${p1}&amp;igraci=${p3}"`));

  // Jeder Monat separat: September (vergangen) und November (kommend), jeweils frei kombinierbar
  assert.equal(selectedTotal((await fin('2026-09', [p1, p3])).text), 1000 + 4000); // P1: Gebühr + Training, P3: nichts
  assert.equal(selectedTotal((await fin('2026-09', [p3])).text), 0);
  assert.equal(selectedTotal((await fin('2026-11', [p3])).text), 3000);
  assert.equal(selectedTotal((await fin('2026-11', [p1, p3])).text), 1000 + 3000);
  assert.equal(selectedTotal((await fin('2026-11')).text), 1000 + 3000);
  // Die Summe entspricht exakt den Einzelbeträgen der Mitglieder
  const { monthlyStatement } = require('../src/billing');
  const get = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  assert.equal(selectedTotal((await fin('2026-10', [p1, p2])).text),
    monthlyStatement(db, get(p1), '2026-10').total + monthlyStatement(db, get(p2), '2026-10').total);

  // Fremde Spieler-IDs werden ignoriert (nicht in Summe, nicht angezeigt)
  const foreign = await fin('2026-10', [p2, stranger]);
  assert.equal(selectedTotal(foreign.text), 2500);
  assert.doesNotMatch(foreign.text, /Stranac|99,00|77,00/);
  // Noch nicht freigegebener Monat eines Spielers: „Obračun u pripremi“, nicht in der Summe
  db.prepare('UPDATE payments SET released = 0 WHERE user_id = ? AND month = ?').run(p3, '2026-10');
  const pending = await fin('2026-10', [p1, p3]);
  assert.equal(selectedTotal(pending.text), 5000);
  assert.match(pending.text, /Obračun u pripremi/);
  db.prepare('UPDATE payments SET released = 1 WHERE user_id = ? AND month = ?').run(p3, '2026-10');
});

test('Elternkonto sieht nur zugeordnete Spieler und kann nichts verändern', async () => {
  const fam = setupFamily('citaj');
  const other = setupFamily('druga');
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  await createParentAccount(admin, { name: 'Roditelj Citaj', username: 'roditelj.citaj', password: 'roditelj-1', players: [fam.p1, fam.p2] });
  await createParentAccount(admin, { name: 'Roditelj Druga', username: 'roditelj.druga', password: 'roditelj-1', players: [other.p1] });
  const parent = client();
  await parent.login('roditelj.citaj', 'roditelj-1');

  // Nur eigene Spieler: weder p3 (nicht zugeordnet) noch fremde Familien oder fremde Elternkonten
  const pages = [
    await parent.request('/roditelj?woche=2026-10-05'),
    await parent.request('/roditelj/finansije?monat=2026-10'),
    await parent.request(`/roditelj/finansije?monat=2026-10&izbor=1&igraci=${fam.p3}&igraci=${other.p1}&igraci=${other.stranger}`),
    await parent.request(`/roditelj?woche=2026-10-05&igrac=${other.p1}&user_id=${fam.p3}`),
  ];
  for (const p of pages) {
    assert.equal(p.status, 200);
    assert.doesNotMatch(p.text, /citaj Treci|citaj Stranac|druga |Roditelj Druga|11:05–12:05|12:05–13:05/);
  }
  assert.equal(selectedTotal(pages[2].text), 0);

  // Kein Zugriff auf Mitglieder-, Trainer- oder Admin-Bereiche
  for (const path of ['/mitglied', '/mitglied/abrechnung', '/mitglied/djeca', '/mitglied/passwort', '/trener',
    '/admin', '/admin/mitglieder', '/admin/termine', '/admin/abrechnung', '/admin/roditelji', '/admin/finansije']) {
    const r = await parent.request(path);
    assert.ok(r.status === 403 || (r.status === 302 && r.location === '/roditelj'), `${path}: ${r.status} ${r.location}`);
  }
  // Keine Änderungen möglich (alle schreibenden Wege abgelehnt, Daten unverändert)
  const lessonsBefore = db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n;
  const usersBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const token = await parent.csrf('/roditelj');
  const lessonId = db.prepare('SELECT id FROM lessons WHERE user_id = ?').get(fam.p1).id;
  const attempts = [
    ['/admin/termine', { user_id: String(fam.p1), date: '2026-10-08', start_time: '09:00', duration_min: '60' }],
    [`/admin/termine/${lessonId}/status`, { status: 'cancelled' }],
    [`/admin/termine/${lessonId}/loeschen`, {}],
    ['/admin/termine/sedmica/objavi', { monday: '2026-11-16' }],
    [`/admin/abrechnung/${fam.p1}/placeno`, { month: '2026-10', paid: '1' }],
    ['/admin/roditelji', { name: 'X', username: 'hack.x', password: 'hack-pass-1', player_ids: String(other.p1) }],
    ['/mitglied/djeca', { name: 'X', username: 'hack.kid', password: 'hack-pass-1' }],
    ['/mitglied/passwort', { current: 'roditelj-1', password: 'novo-pass-1', password2: 'novo-pass-1' }],
    ['/roditelj', {}],
    ['/roditelj/finansije', { igraci: String(fam.p1) }],
  ];
  for (const [path, form] of attempts) {
    const r = await parent.request(path, { method: 'POST', form: { _csrf: token, ...form } });
    assert.ok([302, 403, 404].includes(r.status), `${path}: ${r.status}`);
    if (r.status === 302) assert.equal(r.location, '/roditelj', path);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lessons').get().n, lessonsBefore);
  assert.equal(db.prepare('SELECT cancelled FROM lessons WHERE id = ?').get(lessonId).cancelled, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, usersBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM parent_accounts WHERE username = 'hack.x'").get().n, 0);
  assert.equal(db.prepare("SELECT paid FROM payments WHERE user_id = ? AND month = '2026-10'").get(fam.p1).paid, 0);
  assert.ok(!require('../src/weeks').weekStatus(db, '2026-11-16').released);
  // Die Seiten enthalten keine Formulare zum Ändern (nur die Spieler-Auswahl per GET und Abmelden)
  for (const p of pages) {
    const posts = [...p.text.matchAll(/<form[^>]*method="post"[^>]*action="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(posts)], ['/logout']);
  }
  // Admin kann zuordnen ändern: p2 entfernen → sofort nicht mehr sichtbar
  const acc = db.prepare("SELECT id FROM parent_accounts WHERE username = 'roditelj.citaj'").get();
  const edit = await admin.post(`/admin/roditelji/${acc.id}`, { name: 'Roditelj Citaj', username: 'roditelj.citaj', player_ids: String(fam.p1), active: '1' }, `/admin/roditelji/${acc.id}`);
  assert.equal(edit.status, 302);
  assert.doesNotMatch((await parent.request('/roditelj/finansije?monat=2026-10')).text, /citaj Drugi/);
  // Löschen eines Spielers entfernt ihn auch aus dem Elternkonto; Löschen des Elternkontos lässt Spieler unberührt
  await admin.post(`/admin/roditelji/${acc.id}/obrisi`, {}, `/admin/roditelji/${acc.id}`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parent_accounts WHERE id = ?').get(acc.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id IN (?, ?)').get(fam.p1, fam.p2).n, 2);
  assert.equal((await parent.request('/roditelj')).status, 302);
});
