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

test('Startseitenfoto wird lokal ausgeliefert (keine externen Bilder)', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /img-src 'self' data:;/);
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
  db.prepare("UPDATE users SET billing_mode = 'manual' WHERE id = ?").run(lea.id);
  const manualBill = await member.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(manualBill.text, /15,50/); // 10 KM Grundgebühr + 5,50 KM Posten
  assert.match(manualBill.text, /Ručni obračun/);
  // Admin kann den Obračun wieder „u pripremu“ setzen und erneut freigeben
  await admin.post(`/admin/abrechnung/${lea.id}/odobri`, { month: '2026-10', released: '0' }, '/admin/abrechnung?monat=2026-10');
  assert.match((await member.request('/mitglied/abrechnung?monat=2026-10')).text, /Obračun u pripremi/);
  await admin.post('/admin/abrechnung/odobri-sve', { month: '2026-10', released: '1' }, '/admin/abrechnung?monat=2026-10');
  assert.match((await member.request('/mitglied/abrechnung?monat=2026-10')).text, /15,50/); // noch manuell

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

test('Trainer: anlegen, Terminen zuordnen, Bericht mit Einzel/Gruppe, Zusatzzahlung', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const ids = ['Ana', 'Ben', 'Cem'].map((n) => db.prepare('INSERT INTO users (name, email, password_hash, hourly_rate_cents) VALUES (?, ?, ?, 4000)')
    .run(n, `${n.toLowerCase()}@trainer-test.de`, hashPassword('memberpass1')).lastInsertRowid);

  const created = await admin.post('/admin/treneri', { name: 'Trener Test', rate_individual: '25,00', rate_group: '30', active: '1' }, '/admin/treneri/neu');
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
  const ana = client();
  await ana.login('ana@trainer-test.de', 'memberpass1');
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
  const m = ['Dino', 'Edin', 'Faris'].map((n) => db.prepare('INSERT INTO users (name, email, password_hash, hourly_rate_cents) VALUES (?, ?, ?, 3000)')
    .run(n, `${n.toLowerCase()}@portal-test.de`, hashPassword('memberpass1')).lastInsertRowid);

  // Trainer mit Login anlegen, zweiter Trainer ohne Login
  await admin.post('/admin/treneri', { name: 'Mirza Trener', email: 'mirza@portal-test.de', password: 'trener1234', rate_individual: '20', rate_group: '30', active: '1' }, '/admin/treneri/neu');
  await admin.post('/admin/treneri', { name: 'Drugi Trener', rate_individual: '99', rate_group: '99', active: '1' }, '/admin/treneri/neu');
  const mirza = db.prepare("SELECT * FROM trainers WHERE name = 'Mirza Trener'").get();
  const other = db.prepare("SELECT * FROM trainers WHERE name = 'Drugi Trener'").get();
  assert.ok(mirza.password_hash);
  assert.equal(other.password_hash, null);

  // E-Mail darf nicht doppelt vergeben werden
  const dup = await admin.post('/admin/treneri', { name: 'Dupli', email: 'dino@portal-test.de', password: 'trener1234', active: '1' }, '/admin/treneri/neu');
  assert.equal(dup.status, 400);

  await admin.post('/admin/termine', { kind: 'individual', trainer_id: String(mirza.id), user_id: String(m[0]), date: '2026-09-07', start_time: '09:00', duration_min: '60' }, '/admin/termine');
  await admin.post('/admin/termine', { kind: 'group', trainer_id: String(mirza.id), user_id: String(m[0]), member_ids: [String(m[1]), String(m[2])], date: '2026-09-08', start_time: '09:00', duration_min: '90', price: '15' }, '/admin/termine');
  await admin.post('/admin/termine', { kind: 'individual', trainer_id: String(other.id), user_id: String(m[1]), date: '2026-09-09', start_time: '11:00', duration_min: '60' }, '/admin/termine');

  const t = client();
  const login = await t.login('mirza@portal-test.de', 'trener1234');
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
  await member.login('dino@portal-test.de', 'memberpass1');
  assert.equal((await member.request('/trener')).status, 403);

  // Zugang entziehen
  await admin.post(`/admin/treneri/${mirza.id}`, { name: 'Mirza Trener', email: 'mirza@portal-test.de', rate_individual: '20', rate_group: '30', active: '1', revoke: '1' }, `/admin/treneri/${mirza.id}/uredi`);
  assert.equal((await client().login('mirza@portal-test.de', 'trener1234')).status, 401);
  assert.equal((await t.request('/trener')).status, 302);
});

test('Stalne grupe: anlegen, im Terminformular auswählbar, bearbeiten, löschen', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const ids = ['Goran', 'Hana', 'Ilma'].map((n) => db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(n, `${n.toLowerCase()}@grupe-test.de`, hashPassword('memberpass1')).lastInsertRowid);

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
  await member.login('goran@grupe-test.de', 'memberpass1');
  assert.equal((await member.request('/admin/grupe')).status, 403);

  await admin.post(`/admin/grupe/${group.id}/loeschen`, {}, '/admin/grupe');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_groups').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM training_group_members').get().n, 0);
});

test('Finansije: prihodi (uplate članova + ručno), rashodi (treneri + ručno), rezultat', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const month = '2027-01';
  const m1 = db.prepare('INSERT INTO users (name, email, password_hash, hourly_rate_cents) VALUES (?, ?, ?, 5000)')
    .run('Jasmin', 'jasmin@fin-test.de', hashPassword('memberpass1')).lastInsertRowid;
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
  await member.login('jasmin@fin-test.de', 'memberpass1');
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
  db.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Space', 'space@test.de', ?)").run(hashPassword('mein-pw-123!?'));
  const ok = await client().login(' space@test.de ', ' mein-pw-123!? ');
  assert.equal(ok.status, 302);
  const bad = await client().login('space@test.de', 'mein-pw-123');
  assert.equal(bad.status, 401);
});
