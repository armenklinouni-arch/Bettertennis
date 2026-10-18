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
// Statt echter E-Mails: alle versendeten Nachrichten werden hier gesammelt.
const sentMails = [];
const testMailer = {
  fail: false, // für Fehlertests: Versand schlägt fehl (Grund wird wie bei Resend geloggt)
  async send(message) {
    if (this.fail) {
      console.error(`Resend: slanje nije uspjelo (422): test-greška za ${message.to}`);
      return false;
    }
    sentMails.push(message);
    return true;
  },
};
let base;
let db;

before(async () => {
  // Fester Testzeitpunkt, damit „aktueller Monat“ und „3 Monate zurück“ nicht vom echten Datum abhängen.
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-09T10:00:00') });
  db = openDatabase(':memory:');
  ensureAdmin(db, { email: 'admin@test.de', password: 'adminpass123' });
  // Hauptinstanz mit eingeschalteter Startseite (deren Tests bleiben so erhalten).
  const app = createApp(db, { secret: 'test-secret', publicHomepage: true, mailer: testMailer, appUrl: 'https://bettertennis.net', mailDelayMs: 0 });
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
  // Hero-Fotos (Unsplash) mit dem lokalen Platzfoto als Ersatz
  assert.match(home.text, /class="hero-photo hero-slide" src="https:\/\/unsplash\.com\/[^"]+" data-fallback="\/static\/img\/tennisplatz\.jpg"/);
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

test('Startseite: Programme ohne Kinderbereich und ohne „2–8 igrača“', async () => {
  const home = await client().request('/');
  assert.match(home.text, /Trening po tvojoj mjeri/);
  assert.doesNotMatch(home.text, /Učimo kroz igru|Tenis za djecu/);
  assert.doesNotMatch(home.text, /2–8 igrača/);
  assert.doesNotMatch(home.text, /probni trening/i);
  for (const f of ['individualni', 'grupni', 'video-analiza', 'konsultacije']) {
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

test('Startseite aktiv (Standard): bettertennis.net zeigt die Početna, von dort geht es zum Login', async () => {
  const { publicHomepageFromEnv } = require('../src/app');
  // Railway-Variable: fehlt/leer/1 → Startseite an; nur „0“ schaltet sie aus
  assert.equal(publicHomepageFromEnv(undefined), true);
  assert.equal(publicHomepageFromEnv(''), true);
  assert.equal(publicHomepageFromEnv('1'), true);
  assert.equal(publicHomepageFromEnv('0'), false);

  const fresh = openDatabase(':memory:');
  ensureAdmin(fresh, { email: 'chef@start.test', password: 'chefpass123' });
  fresh.prepare("INSERT INTO users (name, username, email, password_hash) VALUES ('Start Član', 'start.clan', 'start@x.ba', ?)").run(hashPassword('memberpass1'));
  const start = async (options) => {
    const app = createApp(fresh, { secret: 'start-secret', mailer: testMailer, ...options });
    const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    return { srv, url: `http://127.0.0.1:${srv.address().port}` };
  };

  // Ohne Option (wie in Produktion ohne Variable): die bisherige Startseite, unverändert
  let { srv, url } = await start({});
  try {
    const root = await fetch(`${url}/`, { redirect: 'manual' });
    assert.equal(root.status, 200);
    const home = await root.text();
    assert.match(home, /Igraj <span class="hl">bolji tenis<\/span>/);
    assert.match(home, /class="hero-photo[ "]/);
    assert.match(home, /Trening po tvojoj mjeri/);
    assert.match(home, /id="anmeldung"/);
    assert.match(home, />Početna</);
    // Von der Startseite zum Login
    assert.match(home, /href="\/login"[^>]*>Već sam član</);
    assert.match(home, /href="\/login"[^>]*>Prijava za članove</);
    // Login-Seite wieder mit Verweis auf die Anmeldung für Interessenten; Login funktioniert unverändert
    const loginPage = await fetch(`${url}/login`);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /href="\/#anmeldung"/);
    assert.match(loginHtml, /href="\/zaboravljena-lozinka"/);
    const cookie = loginPage.headers.get('set-cookie').split(';')[0];
    const csrf = /name="_csrf" value="([^"]+)"/.exec(loginHtml)[1];
    const res = await fetch(`${url}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, username: 'start.clan', password: 'memberpass1' }).toString(),
    });
    assert.equal(res.headers.get('location'), '/mitglied');
    // Eingeloggt ist die Startseite weiterhin erreichbar (wie vor der Deaktivierung)
    const session = res.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${url}/`, { redirect: 'manual', headers: { cookie: session } })).status, 200);
    // Anmeldeformular für Interessenten funktioniert
    const homeRes = await fetch(`${url}/`);
    const c2 = homeRes.headers.get('set-cookie').split(';')[0];
    const t2 = /name="_csrf" value="([^"]+)"/.exec(await homeRes.text())[1];
    const lead = await fetch(`${url}/anmeldung`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: c2, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: t2, name: 'Novi Interesent', email: 'interes@start.ba', phone: '061 111 222', consent: '1' }).toString(),
    });
    assert.ok([200, 302].includes(lead.status));
    assert.equal(fresh.prepare("SELECT COUNT(*) AS n FROM leads WHERE email = 'interes@start.ba'").get().n, 1);
  } finally {
    srv.close();
  }

  // Mit ausgeschaltetem Schalter wie bisher direkt zum Login
  ({ srv, url } = await start({ publicHomepage: false }));
  try {
    const root = await fetch(`${url}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/login');
    assert.doesNotMatch(await (await fetch(`${url}/login`)).text(), /href="\/#anmeldung"/);
  } finally {
    srv.close();
  }
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

test('Elternkonto Finanzen: einzelne Posten (Datum, Betrag) je ausgewähltem Spieler, Summe pro Spieler und Gesamtsumme', async () => {
  const p1 = makeMember('Detalj Prvi', 'detalj.prvi', { fee: 1000 });
  const p2 = makeMember('Detalj Drugi', 'detalj.drugi');
  const p3 = makeMember('Detalj Treci', 'detalj.treci');
  const lesson = (uid, date, time, price, cancelled = 0) => db.prepare(
    'INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents, cancelled) VALUES (?, ?, ?, 60, ?, ?)'
  ).run(uid, date, time, price, cancelled);
  lesson(p1, '2026-10-06', '14:10', 4000);
  lesson(p1, '2026-10-08', '14:20', 4000, 1); // abgesagt → 0 KM
  lesson(p3, '2026-10-07', '15:10', 3300);
  lesson(p3, '2026-11-17', '15:20', 3300); // Woche noch nicht freigegeben
  db.prepare("INSERT INTO adjustments (user_id, month, description, amount_cents, created_at) VALUES (?, '2026-10', 'Mašina za loptice', 1550, '2026-10-03 12:00:00')").run(p1);
  db.prepare("INSERT INTO adjustments (user_id, month, description, amount_cents, created_at) VALUES (?, '2026-10', 'Turnirska kotizacija', 2500, '2026-10-12 09:00:00')").run(p2);
  for (const uid of [p1, p2, p3]) for (const m of ['2026-10', '2026-11']) db.prepare('INSERT INTO payments (user_id, month, released) VALUES (?, ?, 1)').run(uid, m);

  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  await createParentAccount(admin, { name: 'Roditelj Detalj', username: 'roditelj.detalj', password: 'roditelj-1', players: [p1, p2, p3] });
  const parent = client();
  await parent.login('roditelj.detalj', 'roditelj-1');
  const fin = (month, ids) => parent.request(`/roditelj/finansije?monat=${month}&izbor=1${ids.map((i) => `&igraci=${i}`).join('')}`);
  // Abschnitt eines Spielers aus der Seite herauslösen
  const section = (text, id) => {
    const m = new RegExp(`<section class="card player-statement" data-player="${id}">([\\s\\S]*?)</section>`).exec(text);
    return m ? m[1] : null;
  };

  const r = await fin('2026-10', [p1, p2]);
  assert.equal(r.status, 200);
  const s1 = section(r.text, p1);
  const s2 = section(r.text, p2);
  assert.ok(s1 && s2, 'Abschnitte für ausgewählte Spieler fehlen');
  assert.equal(section(r.text, p3), null); // nicht ausgewählt → keine Posten
  assert.doesNotMatch(r.text, /15:10–16:10/);
  // Spieler 1: Grundgebühr, Trainings mit Datum/Uhrzeit/Betrag, abgesagtes Training, Posten mit Datum
  assert.match(s1, /Detalj Prvi/);
  assert.match(s1, /Mjesečna osnovna članarina[\s\S]*?10,00\sKM/);
  assert.match(s1, /Utorak, 06\.10\.2026\., 14:10–15:10 h[\s\S]*?40,00\sKM/);
  assert.match(s1, /Četvrtak, 08\.10\.2026\., 14:20–15:20 h[\s\S]*?Otkazan[\s\S]*?0,00\sKM/);
  assert.match(s1, /Mašina za loptice[\s\S]*?03\.10\.2026\.[\s\S]*?15,50\sKM/);
  assert.match(s1, /Ukupno Oktobar 2026[\s\S]*?65,50\sKM/); // 10 + 40 + 15,50
  // Spieler 2: nur Posten
  assert.match(s2, /Turnirska kotizacija[\s\S]*?12\.10\.2026\.[\s\S]*?25,00\sKM/);
  assert.match(s2, /Ukupno Oktobar 2026[\s\S]*?25,00\sKM/);
  // Gesamtsumme der ausgewählten Spieler (oben und unter den Posten)
  assert.equal(selectedTotal(r.text), 6550 + 2500);
  assert.match(r.text, /data-grand-total="9050"[^>]*>90,50\sKM/);
  // Die Posten stimmen mit der bestehenden Abrechnung überein (Logik unverändert)
  const { monthlyStatement } = require('../src/billing');
  assert.equal(monthlyStatement(db, db.prepare('SELECT * FROM users WHERE id = ?').get(p1), '2026-10').total, 6550);

  // Andere Auswahl → andere Posten, ohne dass etwas gespeichert wird
  const only3 = await fin('2026-10', [p3]);
  assert.equal(section(only3.text, p1), null);
  assert.match(section(only3.text, p3), /Srijeda, 07\.10\.2026\., 15:10–16:10 h[\s\S]*?33,00\sKM/);
  // Termine aus noch nicht freigegebenen Wochen werden nicht einzeln aufgeführt (wie beim Mitglied)
  const nov = await fin('2026-11', [p3]);
  assert.doesNotMatch(nov.text, /15:20/);
  assert.match(section(nov.text, p3), /još nije objavljen/);
  assert.equal(selectedTotal(nov.text), 3300);
  // Nicht freigegebener Monat: keine Posten, nur „Obračun u pripremi“
  db.prepare("UPDATE payments SET released = 0 WHERE user_id = ? AND month = '2026-10'").run(p2);
  const pend = await fin('2026-10', [p1, p2]);
  assert.doesNotMatch(pend.text, /Turnirska kotizacija/);
  assert.match(section(pend.text, p2), /Obračun u pripremi/);
  assert.equal(selectedTotal(pend.text), 6550);
  // Mitgliederansicht bleibt unverändert (keine zusätzlichen Datumsangaben bei Posten)
  const m = client();
  await m.login('detalj.prvi', 'memberpass1');
  const own = await m.request('/mitglied/abrechnung?monat=2026-10');
  assert.match(own.text, /Mašina za loptice/);
  assert.doesNotMatch(own.text, /03\.10\.2026\./);
});

// ---------------------------------------------------------------- E-Mail / Passwort vergessen
test('Mailversand über Resend: Schlüssel aus RESEND_API_KEY, Absender @bettertennis.net', async () => {
  const { createResendMailer, DEFAULT_FROM } = require('../src/mailer');
  assert.match(DEFAULT_FROM, /@bettertennis\.net>?$/);
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '{"id":"x"}' }; };
  const mailer = createResendMailer({ apiKey: 're_test_123', fetch: fakeFetch });
  assert.equal(await mailer.send({ to: 'clan@example.ba', subject: 'Test', text: 'Zdravo', html: '<p>Zdravo</p>' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_123');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, ['clan@example.ba']);
  assert.match(body.from, /@bettertennis\.net/);
  assert.equal(body.subject, 'Test');
  // Fehler beim Versand oder fehlender Schlüssel: kein Absturz, nur false
  const failing = createResendMailer({ apiKey: 're_x', fetch: async () => ({ ok: false, status: 422, text: async () => 'bad' }) });
  assert.equal(await failing.send({ to: 'a@b.ba', subject: 's', text: 't' }), false);
  const noKey = createResendMailer({ apiKey: '', fetch: async () => { throw new Error('darf nicht aufgerufen werden'); } });
  assert.equal(await noKey.send({ to: 'a@b.ba', subject: 's', text: 't' }), false);
});

test('Moji podaci: Mitglied trägt E-Mail und Telefon ohne Passwort ein; Hinweis solange keine E-Mail hinterlegt ist', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  // Massenanlage bleibt unverändert (ohne E-Mail)
  const bulk = await admin.post('/admin/mitglieder/vise', { lines: 'Mejl Bezadrese' }, '/admin/mitglieder/vise');
  const pw = /<td><code>mejl\.bezadrese<\/code><\/td><td><code>([^<]+)<\/code>/.exec(bulk.text)[1];
  const m = client();
  await m.login('mejl.bezadrese', pw);
  await m.post('/mitglied/email-prozor/kasnije', {}, '/mitglied');
  const hint = /Molimo unesi svoju e-mail adresu kako bi mogao\/la sam\/a resetovati lozinku i primati važne informacije o treninzima/;
  const home = (await m.request('/mitglied')).text;
  assert.match(home, hint);
  assert.match(home, /href="\/mitglied\/moji-podaci"[^>]*>Moji podaci</);
  assert.doesNotMatch(home, />E-mail<\/a>/); // alter Reiter ersetzt
  // Alte Adresse führt zur neuen Seite
  assert.equal((await m.request('/mitglied/email')).location, '/mitglied/moji-podaci');
  const page = await m.request('/mitglied/moji-podaci');
  assert.equal(page.status, 200);
  assert.match(page.text, /<h1>Moji podaci<\/h1>/);
  assert.match(page.text, hint);
  assert.match(page.text, /Mejl Bezadrese/);
  assert.match(page.text, /mejl\.bezadrese/);
  assert.doesNotMatch(page.text, /name="name"|name="username"/); // Name und Benutzername nur angezeigt
  assert.match(page.text, /<input[^>]*name="email"/);
  assert.match(page.text, /<input[^>]*name="phone"/);
  assert.match(page.text, /<button class="btn btn-primary" type="submit">Spremi<\/button>/);
  assert.doesNotMatch(page.text, /Trenutna lozinka|name="password"|Vaša lozinka za BetterTennis/);
  assert.doesNotMatch(page.text, /bez-emaila/); // interne Ersatzadresse wird nicht angezeigt
  // Ungültig oder bereits vergeben → abgelehnt, nichts gespeichert
  for (const email of ['kein-mail', 'admin@test.de', 'x@bez-emaila.bettertennis.local']) {
    assert.equal((await m.post('/mitglied/moji-podaci', { email, phone: '061 111 222' }, '/mitglied/moji-podaci')).status, 400, email);
  }
  assert.equal((await m.post('/mitglied/moji-podaci', { email: '', phone: 'abc<script>' }, '/mitglied/moji-podaci')).status, 400);
  let user = db.prepare("SELECT * FROM users WHERE username = 'mejl.bezadrese'").get();
  assert.match(user.email, /bez-emaila/);
  assert.equal(user.phone, null);
  // Nur Telefon (noch keine E-Mail) → ohne Passwort gespeichert, Ersatzadresse bleibt
  assert.equal((await m.post('/mitglied/moji-podaci', { email: '', phone: '+387 61 111 222' }, '/mitglied/moji-podaci')).status, 302);
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(user.phone, '+387 61 111 222');
  assert.match(user.email, /bez-emaila/);
  // Erstes Eintragen der E-Mail → ohne Passwort; Name/Benutzername im Formular werden ignoriert
  const first = await m.post('/mitglied/moji-podaci', { email: ' Mejl@Primjer.ba ', phone: '+387 61 111 222', name: 'Hacker', username: 'hacker' }, '/mitglied/moji-podaci');
  assert.equal(first.status, 302);
  assert.equal(first.location, '/mitglied/moji-podaci');
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  assert.equal(user.email, 'Mejl@Primjer.ba');
  assert.equal(user.name, 'Mejl Bezadrese');
  assert.equal(user.username, 'mejl.bezadrese');
  const saved = await m.request('/mitglied/moji-podaci');
  assert.match(saved.text, /Vaši podaci su sačuvani/);
  assert.match(saved.text, /value="Mejl@Primjer\.ba"/);
  assert.match(saved.text, /value="\+387 61 111 222"/);
  assert.doesNotMatch((await m.request('/mitglied')).text, hint);
  // Telefon ändern (E-Mail gleich) → kein Passwort; Telefon leeren ist erlaubt
  assert.equal((await m.post('/mitglied/moji-podaci', { email: 'Mejl@Primjer.ba', phone: '062 333 444' }, '/mitglied/moji-podaci')).status, 302);
  assert.equal(db.prepare('SELECT phone FROM users WHERE id = ?').get(user.id).phone, '062 333 444');
  assert.equal((await m.post('/mitglied/moji-podaci', { email: 'Mejl@Primjer.ba', phone: '' }, '/mitglied/moji-podaci')).status, 302);
  assert.equal(db.prepare('SELECT phone FROM users WHERE id = ?').get(user.id).phone, null);
  // Eine vorhandene E-Mail darf nicht geleert werden
  assert.equal((await m.post('/mitglied/moji-podaci', { email: '', phone: '' }, '/mitglied/moji-podaci')).status, 400);
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(user.id).email, 'Mejl@Primjer.ba');

  // Kinder-Konto hat keinen Zugriff
  await m.post('/mitglied/djeca', { name: 'Mejl Dijete', username: 'mejl.kid', password: 'kid-pass-123' }, '/mitglied/djeca');
  const kid = client();
  await kid.login('mejl.kid', 'kid-pass-123');
  assert.equal((await kid.request('/mitglied/moji-podaci')).status, 403);
  assert.equal((await kid.post('/mitglied/moji-podaci', { email: 'kid@primjer.ba', phone: '1' }, '/mitglied')).status, 403);
  const kidHome = (await kid.request('/mitglied')).text;
  assert.doesNotMatch(kidHome, hint);
  assert.doesNotMatch(kidHome, /moji-podaci/);
});

test('Moji podaci: Ändern einer vorhandenen E-Mail fragt nach dem BetterTennis-Passwort', async () => {
  makeMember('Podaci Clan', 'podaci.clan'); // hat podaci.clan@kids-test.de, Passwort memberpass1
  const m = client();
  await m.login('podaci.clan', 'memberpass1');
  const id = db.prepare("SELECT id FROM users WHERE username = 'podaci.clan'").get().id;
  const emailOf = () => db.prepare('SELECT email, phone FROM users WHERE id = ?').get(id);
  // Ohne Passwort → Rückfrage statt Speichern (auch Telefon wird noch nicht gespeichert)
  const ask = await m.post('/mitglied/moji-podaci', { email: 'novi@primjer.ba', phone: '061 000 111' }, '/mitglied/moji-podaci');
  assert.equal(ask.status, 200);
  assert.match(ask.text, /<label>Vaša lozinka za BetterTennis/);
  assert.match(ask.text, /Unesite lozinku kojom se prijavljujete na BetterTennis, ne lozinku vašeg e-mail računa\./);
  assert.match(ask.text, /<input[^>]*name="password"[^>]*type="password"/);
  assert.match(ask.text, /value="novi@primjer\.ba"/);
  assert.match(ask.text, /value="061 000 111"/);
  assert.deepEqual({ ...emailOf() }, { email: 'podaci.clan@kids-test.de', phone: null });
  // Falsches Passwort → Fehler, nichts gespeichert
  const wrong = await m.post('/mitglied/moji-podaci', { email: 'novi@primjer.ba', phone: '061 000 111', password: 'falsch-123' }, '/mitglied/moji-podaci');
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /Vaša lozinka za BetterTennis/);
  assert.equal(emailOf().email, 'podaci.clan@kids-test.de');
  // Richtiges Passwort → beides gespeichert
  const ok = await m.post('/mitglied/moji-podaci', { email: 'novi@primjer.ba', phone: '061 000 111', password: 'memberpass1' }, '/mitglied/moji-podaci');
  assert.equal(ok.status, 302);
  assert.deepEqual({ ...emailOf() }, { email: 'novi@primjer.ba', phone: '061 000 111' });
  // Gleiche Adresse (nur Groß-/Kleinschreibung) oder nur Telefon → kein Passwort
  assert.equal((await m.post('/mitglied/moji-podaci', { email: 'Novi@Primjer.ba', phone: '061 000 222' }, '/mitglied/moji-podaci')).status, 302);
  assert.deepEqual({ ...emailOf() }, { email: 'Novi@Primjer.ba', phone: '061 000 222' });
  // Normale Seite zeigt kein Passwortfeld
  assert.doesNotMatch((await m.request('/mitglied/moji-podaci')).text, /name="password"/);
  // Passwort ändern bleibt ein eigener Bereich
  const pwPage = await m.request('/mitglied/passwort');
  assert.equal(pwPage.status, 200);
  assert.match(pwPage.text, /Trenutna lozinka/);
  assert.match((await m.request('/mitglied')).text, /href="\/mitglied\/passwort"[^>]*>Lozinka</);
});

test('Moji podaci: Admin sieht E-Mail und Telefon beim Mitglied und kann sie ändern', async () => {
  const id = makeMember('Podaci Admin', 'podaci.admin');
  const m = client();
  await m.login('podaci.admin', 'memberpass1');
  await m.post('/mitglied/moji-podaci', { email: 'podaci.admin@kids-test.de', phone: '061 555 666' }, '/mitglied/moji-podaci');
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const list = (await admin.request('/admin/mitglieder')).text;
  assert.match(list, /podaci\.admin@kids-test\.de<br>061 555 666/);
  const edit = (await admin.request(`/admin/mitglieder/${id}`)).text;
  assert.match(edit, /name="email"[^>]*value="podaci\.admin@kids-test\.de"/);
  assert.match(edit, /name="phone"[^>]*value="061 555 666"/);
  await admin.post(`/admin/mitglieder/${id}`, {
    name: 'Podaci Admin', username: 'podaci.admin', email: 'admin.promijenio@primjer.ba', phone: '062 777 888', active: '1', hourly_rate: '40', monthly_fee: '0',
  }, `/admin/mitglieder/${id}`);
  assert.deepEqual({ ...db.prepare('SELECT email, phone FROM users WHERE id = ?').get(id) }, { email: 'admin.promijenio@primjer.ba', phone: '062 777 888' });
  const page = (await m.request('/mitglied/moji-podaci')).text;
  assert.match(page, /value="admin\.promijenio@primjer\.ba"/);
  assert.match(page, /value="062 777 888"/);
});

test('Passwort vergessen: Link per E-Mail, neues Passwort setzen, Benutzername bleibt gleich', async () => {
  const id = makeMember('Zaboravna Clanica', 'zaboravna');
  db.prepare("UPDATE users SET email = 'zaboravna@primjer.ba' WHERE id = ?").run(id);
  makeMember('Bez Mejla', 'bez.mejla');
  db.prepare("UPDATE users SET email = 'bez.mejla@bez-emaila.bettertennis.local' WHERE username = 'bez.mejla'").run();
  sentMails.length = 0;

  const login = await client().request('/login');
  assert.match(login.text, /href="\/zaboravljena-lozinka"/);
  const anon = client();
  assert.equal((await anon.request('/zaboravljena-lozinka')).status, 200);
  const generic = /Ako je ta e-mail adresa povezana s članskim računom, poslali smo link/;
  // Unbekannte Adresse, Ersatzadresse und Admin-Adresse: gleiche Antwort, keine E-Mail
  for (const email of ['niko@primjer.ba', 'bez.mejla@bez-emaila.bettertennis.local', 'admin@test.de', 'kein-mail']) {
    const r = await anon.post('/zaboravljena-lozinka', { email }, '/zaboravljena-lozinka');
    assert.equal(r.status, 200, email);
    assert.match(r.text, generic);
  }
  assert.equal(sentMails.length, 0);

  // Bekannte Adresse (Groß/Klein egal): eine E-Mail mit Link und Benutzername
  const r = await anon.post('/zaboravljena-lozinka', { email: 'Zaboravna@Primjer.ba' }, '/zaboravljena-lozinka');
  assert.match(r.text, generic);
  assert.equal(sentMails.length, 1);
  const mail = sentMails[0];
  assert.equal(mail.to, 'zaboravna@primjer.ba');
  assert.match(mail.subject, /lozink/i);
  assert.match(mail.text, /zaboravna/); // Benutzername zur Erinnerung
  const link = /https:\/\/bettertennis\.net\/nova-lozinka\/([A-Za-z0-9_-]{30,})/.exec(mail.text);
  assert.ok(link, 'Link fehlt');
  assert.ok(mail.html.includes(link[0]));
  const token = link[1];
  // Der Token wird nur gehasht gespeichert
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?').get(token).n, 0);

  const path = `/nova-lozinka/${token}`;
  const form = await anon.request(path);
  assert.equal(form.status, 200);
  assert.match(form.text, /zaboravna/); // Benutzername wird angezeigt, ist aber nicht änderbar
  assert.doesNotMatch(form.text, /name="username"/);
  assert.equal((await anon.post(path, { password: 'kurz', password2: 'kurz' }, path)).status, 400);
  assert.equal((await anon.post(path, { password: 'novaLozinka1', password2: 'drugaLozinka' }, path)).status, 400);
  const ok = await anon.post(path, { password: 'Sunce123x', password2: 'Sunce123x', username: 'gehackt' }, path);
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/login');
  assert.equal(db.prepare('SELECT username FROM users WHERE id = ?').get(id).username, 'zaboravna');
  assert.equal((await client().login('zaboravna', 'memberpass1')).status, 401);
  assert.equal((await client().login('zaboravna', 'Sunce123x')).location, '/mitglied');
  // Link ist nur einmal gültig
  assert.match((await anon.request(path)).text, /nije važeći ili je istekao/);
  assert.equal((await anon.post(path, { password: 'Opet12345', password2: 'Opet12345' }, '/zaboravljena-lozinka')).status, 400);
  assert.equal((await client().login('zaboravna', 'Opet12345')).status, 401);

  // Abgelaufener Link (nach 60 Minuten)
  await anon.post('/zaboravljena-lozinka', { email: 'zaboravna@primjer.ba' }, '/zaboravljena-lozinka');
  const token2 = /nova-lozinka\/([A-Za-z0-9_-]+)/.exec(sentMails[sentMails.length - 1].text)[1];
  await atTime('2026-10-09T11:01:00', async () => {
    assert.match((await client().request(`/nova-lozinka/${token2}`)).text, /nije važeći ili je istekao/);
  });
  // Ungültiger Token
  assert.match((await anon.request('/nova-lozinka/abc')).text, /nije važeći ili je istekao/);
  // Admin-Login bleibt unverändert
  assert.equal((await client().login('admin@test.de', 'adminpass123')).location, '/admin');
});

test('Admin pflegt E-Mail-Adressen der Mitglieder und setzt weiterhin selbst Passwörter zurück', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const bulk = await admin.post('/admin/mitglieder/vise', { lines: 'Admin Mejl' }, '/admin/mitglieder/vise');
  assert.ok(/admin\.mejl/.test(bulk.text));
  const member = db.prepare("SELECT * FROM users WHERE username = 'admin.mejl'").get();
  const edit = `/admin/mitglieder/${member.id}`;
  const base = { name: 'Admin Mejl', username: 'admin.mejl', active: '1' };
  // Ersatzadresse wird im Formular nicht angezeigt; leeres Feld lässt das Mitglied ohne E-Mail
  const page = await admin.request(edit);
  assert.doesNotMatch(page.text, /bez-emaila/);
  assert.equal((await admin.post(edit, { ...base, email: '' }, edit)).status, 302);
  assert.match(db.prepare('SELECT email FROM users WHERE id = ?').get(member.id).email, /@bez-emaila\.bettertennis\.local$/);
  // Eintragen, korrigieren, doppelt/ungültig abgelehnt
  assert.equal((await admin.post(edit, { ...base, email: 'admin.mejl@primjer.ba' }, edit)).status, 302);
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(member.id).email, 'admin.mejl@primjer.ba');
  assert.equal((await admin.post(edit, { ...base, email: 'admin.mejl@primjer.com' }, edit)).status, 302);
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').get(member.id).email, 'admin.mejl@primjer.com');
  assert.equal((await admin.post(edit, { ...base, email: 'admin@test.de' }, edit)).status, 400);
  assert.equal((await admin.post(edit, { ...base, email: 'nije-mejl' }, edit)).status, 400);
  // Passwort-Zurücksetzen durch den Admin funktioniert weiterhin parallel
  assert.equal((await admin.post(edit, { ...base, email: 'admin.mejl@primjer.com', password: 'AdminNovo77' }, edit)).status, 302);
  assert.equal((await client().login('admin.mejl', 'AdminNovo77')).location, '/mitglied');
  // … und danach auch per E-Mail-Link
  sentMails.length = 0;
  await client().post('/zaboravljena-lozinka', { email: 'admin.mejl@primjer.com' }, '/zaboravljena-lozinka');
  assert.equal(sentMails.length, 1);
  // Einzelnes Anlegen verlangt weiterhin eine E-Mail-Adresse (unverändert)
  assert.equal((await admin.post('/admin/mitglieder', { name: 'Bez', username: 'bez.adrese', email: '', password: 'nekaLozinka1', active: '1' }, '/admin/mitglieder/neu')).status, 400);
});

test('Passwort vergessen: höchstens 3 Links pro E-Mail-Adresse in 15 Minuten; nur Mitglieder-Konten', async () => {
  const id = makeMember('Limit Mejl', 'limit.mejl');
  db.prepare("UPDATE users SET email = 'limit.mejl@primjer.ba' WHERE id = ?").run(id);
  db.prepare("UPDATE trainers SET email = 'trener.mejl@primjer.ba' WHERE id = (SELECT MIN(id) FROM trainers)").run();
  sentMails.length = 0;
  const anon = client();
  for (let i = 0; i < 5; i++) {
    const r = await anon.post('/zaboravljena-lozinka', { email: 'limit.mejl@primjer.ba' }, '/zaboravljena-lozinka');
    assert.match(r.text, /poslali smo link/);
  }
  assert.equal(sentMails.length, 3);
  // Trainer-E-Mail führt zu keinem Link (Funktion ist für Mitglieder)
  await anon.post('/zaboravljena-lozinka', { email: 'trener.mejl@primjer.ba' }, '/zaboravljena-lozinka');
  assert.equal(sentMails.length, 3);
});

// ---------------------------------------------------------------- Startseite: neues Design
// Alle sichtbaren Texte der Startseite vor dem Redesign – sie müssen vollständig erhalten bleiben.
// (Die früheren Emoji-Icons 🎾 📅 🏅 sind keine Texte; sie wurden durch Linien-Icons ersetzt.)
const HOME_TEXTS = [
  'Teniska škola',
  'Igraj',
  'bolji tenis',
  '– uz trening koji ti odgovara.',
  'Individualni i grupni časovi za sve nivoe znanja. Prijavi se bez obaveze i javit ćemo ti se u najkraćem roku.',
  'Prijavi se sada',
  'Već sam član',
  'ITF treneri',
  'Djeca i odrasli',
  'Video analiza',
  'Naši programi',
  'Trening po tvojoj mjeri',
  'Biraj između individualnog i grupnog treninga, a uz to nudimo video analizu i konsultacije.',
  'Jedan na jedan',
  'Individualni trening',
  'Trening jedan na jedan, potpuno prilagođen tvom tempu i ciljevima – najbrži napredak u tehnici i taktici.',
  'Mala grupa',
  'Grupni trening',
  'Trening u maloj grupi igrača sličnog nivoa. Više igre, motivacije i druženja.',
  'Tehnika',
  'Snimamo tvoje udarce i analiziramo ih usporeno, kadar po kadar – vidiš tačno šta i kako popraviti.',
  'Plan i savjeti',
  'Konsultacije',
  'Razgovaramo o tvojim ciljevima, planu treninga, opremi i pripremi za turnire.',
  'Za svaki nivo',
  'Treninzi su prilagođeni svim nivoima – od početnika do naprednih igrača. Nudimo grupne i individualne treninge, video analizu i konsultacije.',
  'Sedmični raspored',
  'Kao član u svom profilu vidiš sve termine treninga od ponedjeljka do nedjelje.',
  'Treneri',
  'Svi naši treneri su certificirani ITF treneri sa dugogodišnjim iskustvom.',
  'Zanimaju te časovi tenisa?',
  'Popuni obrazac – javit ćemo ti se u roku od nekoliko dana.',
  'Ime i prezime *',
  'E-mail *',
  'Broj telefona *',
  'Nivo znanja',
  'Početnik',
  'Povratnik',
  'Napredni',
  'Takmičar',
  'Kada imaš vremena? (dani / sati)',
  'Poruka',
  'Molimo ostavite prazno',
  'Slažem se da se moji podaci sačuvaju radi kontakta. *',
  'Prijavi se bez obaveze'
];

test('Startseite (neues Design): alle bisherigen Texte und Inhalte bleiben erhalten', async () => {
  const res = await client().request('/');
  assert.equal(res.status, 200);
  const main = res.text.slice(res.text.indexOf('<main'), res.text.indexOf('</main>'));
  const visible = main.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
  for (const t of HOME_TEXTS) assert.ok(visible.includes(t), `Text fehlt: ${t}`);
  // Formular und Links funktionieren wie bisher
  assert.match(main, /<form method="post" action="\/anmeldung"/);
  assert.match(main, /href="#anmeldung"[^>]*>Prijavi se sada</);
  assert.match(main, /id="programi"/);
  assert.equal((main.match(/class="program-card/g) || []).length, 4);
});

test('Startseite (neues Design): großer Hero mit Tennisfoto, Slogan und klarem Login-Button', async () => {
  const res = await client().request('/');
  const main = res.text.slice(res.text.indexOf('<main'), res.text.indexOf('</main>'));
  // Eigener Rahmen nur für die Startseite (andere Seiten bleiben unberührt)
  assert.match(main, /<div class="home">/);
  const hero = /<section class="hero home-hero"[\s\S]*?<\/section>/.exec(main);
  assert.ok(hero, 'Hero-Bereich fehlt');
  // Tennisfotos (Diashow): frei nutzbar von Unsplash, mit lokalem Ersatzbild
  assert.match(hero[0], /<img class="hero-photo hero-slide" src="https:\/\/unsplash\.com\/photos\/[\w-]+\/download\?w=1600" data-fallback="\/static\/img\/tennisplatz\.jpg"/);
  assert.match(hero[0], /<h1>Igraj <span class="hl">bolji tenis<\/span> – uz trening koji ti odgovara\.<\/h1>/);
  // Klarer Login-Button im Neon-Akzent, als erster Button
  const actions = /<div class="hero-actions">([\s\S]*?)<\/div>/.exec(hero[0])[1];
  assert.match(actions.trim(), /^<a class="btn btn-neon btn-lg" href="\/login">Već sam član<\/a>/);
  assert.match(actions, /<a class="btn btn-outline-light btn-lg" href="#anmeldung">Prijavi se sada<\/a>/);
  // Bildquellen nur von freien Bilddiensten bzw. lokal
  const srcs = [...main.matchAll(/(?:src|data-fallback)="([^"]+)"/g)].map((m) => m[1]);
  for (const s of srcs) assert.match(s, /^(\/static\/|https:\/\/unsplash\.com\/photos\/)/, s);
  // Andere Seiten bekommen das Startseiten-Design nicht
  assert.doesNotMatch((await client().request('/login')).text, /class="home"/);
});

test('Startseite (neues Design): Farben Dunkelblau/Hellblau/Weiß mit Neongelb, kurze und dezente Animationen', async () => {
  const fs = require('node:fs');
  const css = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const start = css.indexOf('/* === Početna (Startseite)');
  assert.ok(start >= 0, 'Startseiten-Block im CSS fehlt');
  const home = css.slice(start);
  // Farbpalette
  for (const v of ['--home-navy', '--home-sky', '--home-ice', '--home-neon']) assert.match(home, new RegExp(`${v}:\\s*#[0-9a-f]{6}`, 'i'), v);
  // Alle Regeln des Blocks sind auf die Startseite beschränkt
  const selectors = [...home.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2].trim()).filter((s) => s && !/^(from|to|\d+%)/.test(s));
  for (const sel of selectors) for (const part of sel.split(',')) assert.match(part.trim(), /^\.home\b/, `nicht auf .home beschränkt: ${part}`);
  // Animationen nach emil-design-eng: kurz, eigene ease-out-Kurve, keine „transition: all“, kein scale(0), kein ease-in
  assert.match(home, /--home-ease:\s*cubic-bezier\(0\.23,\s*1,\s*0\.32,\s*1\)/);
  assert.doesNotMatch(home, /transition:\s*all/);
  assert.doesNotMatch(home, /scale\(0\)/);
  assert.doesNotMatch(home, /\bease-in\b(?!-out)/);
  // Kurz (≤ 600 ms) – einzige Ausnahme: der bewusst langsame Bildwechsel im Hero (.hero-slide)
  for (const line of home.split('\n')) {
    for (const m of line.matchAll(/(\d+)ms/g)) {
      if (Number(m[1]) > 600) assert.match(line, /\.hero-slide/, `zu lange Animation: ${line.trim()}`);
    }
  }
  assert.doesNotMatch(home, /\d(\.\d+)?s\b(?![a-z])/, 'Zeitangaben in ms angeben');
  // Druck-Feedback auf Buttons, Hover nur bei echter Maus, Rücksicht auf reduzierte Bewegung
  assert.match(home, /\.home \.btn:active\s*\{[^}]*scale\(0\.97\)/);
  assert.match(home, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(home, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.home/);
});


// ---------------------------------------------------------------- Startseite: Bilder und Icons (Überarbeitung)
const FREE_PHOTO = /^https:\/\/(unsplash\.com\/photos\/([\w-]+)\/download\?w=\d+|images\.pexels\.com\/photos\/(\d+)\/[\w.-]+\?[\w=&]+)$/;
const photoId = (src) => { const m = FREE_PHOTO.exec(src); return m && (m[2] || m[3]); };

test('Startseite: Hauptbild als sanfte Diashow mit 3–5 klaren Tennisfotos (frei nutzbar, einheitlicher Stil)', async () => {
  const res = await client().request('/');
  const hero = /<section class="hero home-hero"[\s\S]*?<\/section>/.exec(res.text)[0];
  const slides = [...hero.matchAll(/<img class="hero-photo hero-slide" src="([^"]+)" data-fallback="([^"]+)"([^>]*)>/g)];
  assert.ok(slides.length >= 3 && slides.length <= 5, `Anzahl Bilder: ${slides.length}`);
  const ids = slides.map((m) => photoId(m[1]));
  for (const [i, m] of slides.entries()) {
    assert.ok(ids[i], `kein freies Foto: ${m[1]}`);
    assert.equal(m[2], '/static/img/tennisplatz.jpg'); // lokales Ersatzbild
  }
  assert.equal(new Set(ids).size, slides.length, 'Bilder doppelt');
  assert.doesNotMatch(res.text, /TDahyDz3gPI/); // keine Tribüne mehr
  assert.match(slides[0][3], /loading="eager"/);
  assert.match(hero, /<div class="hero-slides" aria-hidden="true">/);
  // Texte, Login-Button und Struktur bleiben
  assert.match(hero, /<a class="btn btn-neon btn-lg" href="\/login">Već sam član<\/a>/);

  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const home = css.slice(css.indexOf('/* === Početna (Startseite)'));
  // Sanfter, langsamer Wechsel: nur Deckkraft (und leichter Zoom), lange Zykluszeit, je Bild eine Verzögerung
  const kf = /@keyframes home-slide \{([\s\S]*?)\n\}/.exec(home);
  assert.ok(kf, 'Keyframes für den Bildwechsel fehlen');
  assert.doesNotMatch(kf[1].replace(/opacity|transform|scale\([\d.]+\)/g, ''), /[a-z-]+\s*:/);
  const cycle = /\.home \.hero-slide \{[^}]*animation: home-slide (\d+)ms/.exec(home);
  assert.ok(cycle && Number(cycle[1]) >= 20000, 'Bildwechsel zu schnell');
  for (let i = 2; i <= slides.length; i++) assert.match(home, new RegExp(`\\.home \\.hero-slide:nth-child\\(${i}\\) \\{ animation-delay: \\d+ms; \\}`));
  // Einheitlicher Bildstil für Hero und Karten
  assert.match(home, /--home-photo-filter:\s*[^;]+;/);
  assert.match(home, /\.home \.hero-slide \{[^}]*filter: var\(--home-photo-filter\)/);
  // „Bewegung reduzieren“: kein Wechsel, nur das erste Bild
  assert.match(home, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.home \.hero-slide \{[^}]*animation: none/);
});

test('Startseite: Programmkarten zeigen Linien-Icons im Stil der Vorteile (ohne Fotos)', async () => {
  const res = await client().request('/');
  const section = /<section class="section" id="programi"[\s\S]*?<\/section>/.exec(res.text)[0];
  const cards = [...section.matchAll(/<article class="program-card[\s\S]*?<\/article>/g)].map((m) => m[0]);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((c) => /<h3>([^<]+)<\/h3>/.exec(c)[1]), ['Individualni trening', 'Grupni trening', 'Video analiza', 'Konsultacije']);
  // Gleicher Stil wie die Icons bei den Vorteilen: gleiche Kachel, gleiches SVG-Format
  const features = /<section class="section features"[\s\S]*?<\/section>/.exec(res.text)[0];
  const svgOpen = /<svg[^>]*>/.exec(features)[0];
  const icons = cards.map((c) => {
    assert.doesNotMatch(c, /<img|unsplash|pexels/, 'Karte enthält noch ein Foto');
    const m = /<div class="program-icon feature-icon" aria-hidden="true">(<svg[^>]*>)([\s\S]*?<\/svg>)<\/div>/.exec(c);
    assert.ok(m, 'Icon fehlt');
    assert.equal(m[1], svgOpen);
    assert.doesNotMatch(m[2], /fill="(?!none)|style=/);
    return m[2];
  });
  const featureIcons = [...features.matchAll(/<svg[^>]*>([\s\S]*?<\/svg>)/g)].map((m) => m[1]);
  assert.equal(new Set([...icons, ...featureIcons]).size, 7, 'Icons müssen sich unterscheiden');
  // Texte der Karten unverändert
  assert.match(cards[0], /Trening jedan na jedan, potpuno prilagođen tvom tempu i ciljevima – najbrži napredak u tehnici i taktici\./);
  assert.match(cards[3], /<span class="tag tag-kind is-group">Plan i savjeti<\/span>/);
  // Abstand der Icon-Kachel in der Karte
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const home = css.slice(css.indexOf('/* === Početna (Startseite)'));
  assert.match(home, /\.home \.program-card > \.program-icon \{/);
});

test('Startseite: eigene Fotos für die Programmkarten lassen sich ohne Code einsetzen (Ordner public/img/programi)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { programMedia, PROGRAM_PHOTO_DIR } = require('../src/routes/public');
  // Ordner mit Anleitung ist im Projekt vorhanden
  assert.equal(PROGRAM_PHOTO_DIR, path.join(__dirname, '..', 'public', 'img', 'programi'));
  assert.ok(fs.existsSync(path.join(PROGRAM_PHOTO_DIR, 'LIESMICH.md')));
  const pr = { slug: 'individualni', icon: 'racket', title: 'Individualni trening', alt: 'Individualni trening' };
  // Ohne Foto: Icon
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-programi-'));
  try {
    assert.match(String(programMedia(pr, dir)), /^<div class="program-icon feature-icon" aria-hidden="true"><svg/);
    // Mit Foto (jpg, jpeg, png oder webp): Bild im einheitlichen Kartenformat, Icon entfällt
    fs.writeFileSync(path.join(dir, 'individualni.webp'), 'x');
    const html = String(programMedia(pr, dir));
    assert.match(html, /^<div class="program-img"><img src="\/static\/img\/programi\/individualni\.webp\?v=\d+" alt="Individualni trening" width="400" height="300" loading="lazy" decoding="async"><\/div>$/);
    // Andere Karten bleiben beim Icon
    assert.match(String(programMedia({ ...pr, slug: 'grupni', icon: 'group' }, dir)), /program-icon/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Einheitlicher Ausschnitt und Farbwirkung für eingesetzte Fotos bleiben im CSS
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const rule = /\.home \.program-img img \{([^}]*)\}/.exec(css.slice(css.indexOf('/* === Početna (Startseite)')))[1];
  assert.match(rule, /aspect-ratio: 4 \/ 3/);
  assert.match(rule, /object-fit: cover/);
  assert.match(rule, /filter: var\(--home-photo-filter\)/);
});

test('Startseite: schlichte, einheitliche Linien-Icons bei den drei Vorteilen', async () => {
  const res = await client().request('/');
  const features = /<section class="section features"[\s\S]*?<\/section>/.exec(res.text)[0];
  const icons = [...features.matchAll(/<div class="feature-icon" aria-hidden="true">([\s\S]*?)<\/div>/g)].map((m) => m[1].trim());
  assert.equal(icons.length, 3);
  for (const icon of icons) {
    assert.equal((icon.match(/<svg/g) || []).length, 1);
    assert.match(icon, /^<svg class="line-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1\.75" stroke-linecap="round" stroke-linejoin="round" focusable="false">/);
    assert.doesNotMatch(icon, /fill="(?!none)|style=/);
  }
  assert.equal(new Set(icons).size, 3);
  assert.doesNotMatch(features, /🎾|📅|🏅/);
  // Reihenfolge und Texte der Vorteile unverändert
  assert.deepEqual([...features.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]), ['Za svaki nivo', 'Sedmični raspored', 'Treneri']);
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css.slice(css.indexOf('/* === Početna (Startseite)')), /\.home \.feature-icon \.line-icon \{[^}]*width: 24px/);
});

test('Startseite: Federball-Bild aus dem Hauptbild entfernt, übrige Bilder und langsamer Übergang bleiben', async () => {
  const res = await client().request('/');
  const ids = [...res.text.matchAll(/class="hero-photo hero-slide" src="https:\/\/unsplash\.com\/photos\/([\w-]+)\//g)].map((m) => m[1]);
  assert.doesNotMatch(res.text, /QBCiW-A_UNk/);
  assert.deepEqual(ids, ['yKMJLLtoDv4', 'AldB5IWh8l4', 'aG6ByqGXiXg', 'LwxVG0VQ3RY']);
  // Gleiches Tempo wie vorher: je Bild 7 s sichtbar, Überblendung knapp 2 s
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const home = css.slice(css.indexOf('/* === Početna (Startseite)'));
  const cycle = Number(/\.home \.hero-slide \{[^}]*animation: home-slide (\d+)ms/.exec(home)[1]);
  assert.equal(cycle, ids.length * 7000);
  for (let i = 2; i <= ids.length; i++) assert.match(home, new RegExp(`\\.home \\.hero-slide:nth-child\\(${i}\\) \\{ animation-delay: ${(i - 1) * 7000}ms; \\}`));
  assert.doesNotMatch(home, /\.hero-slide:nth-child\(5\)/);
  const kf = /@keyframes home-slide \{([\s\S]*?)\n\}/.exec(home)[1];
  // Keyframes mit voller Deckkraft: [Ende des Einblendens, Ende der Standzeit]
  const full = [...kf.matchAll(/(\d+)% \{ opacity: 1; \}/g)].map((m) => Number(m[1]) / 100 * cycle);
  assert.equal(full.length, 2);
  assert.ok(full[0] >= 1500 && full[0] <= 2000, `Überblendung ${full[0]} ms`);
  assert.equal(full[1], 7000);
});

// ---------------------------------------------------------------- Automatische Sicherung per E-Mail
test('Backup-Mail: aktuelle Datenbank als Anhang an bettertennis.net@gmail.com, mit Datum und Uhrzeit (Sarajevo)', async () => {
  const { sendBackupMail, BACKUP_EMAIL_DEFAULT } = require('../src/backup');
  assert.equal(BACKUP_EMAIL_DEFAULT, 'bettertennis.net@gmail.com');
  const mails = [];
  const mailer = { async send(m) { mails.push(m); return true; } };
  const now = new Date('2026-10-18T20:00:00Z').getTime(); // Sonntag 22:00 in Sarajevo (Sommerzeit)
  const result = await sendBackupMail(db, mailer, { now });
  assert.equal(result.ok, true);
  assert.equal(mails.length, 1);
  const mail = mails[0];
  assert.equal(mail.to, 'bettertennis.net@gmail.com');
  assert.match(mail.subject, /sigurnosna kopija/i);
  assert.match(mail.subject, /18\.10\.2026\. 22:00/);
  assert.match(mail.text, /18\.10\.2026\. u 22:00/);
  assert.match(mail.text, /Sarajevo/);
  assert.equal(mail.attachments.length, 1);
  const att = mail.attachments[0];
  assert.equal(att.filename, 'bettertennis-2026-10-18-2200.db');
  // Der Anhang ist eine vollständige, lesbare Kopie der Datenbank (wie „Sigurnosna kopija“)
  const buf = Buffer.from(att.content, 'base64');
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-backup-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'b.db'), buf);
    const copy = new DatabaseSync(path.join(dir, 'b.db'));
    for (const t of ['users', 'lessons', 'payments', 'parent_accounts']) {
      assert.equal(copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, t);
    }
    copy.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Keine temporären Dateien bleiben liegen
  assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('bt-mailbackup-')).length, 0);
});

test('Resend-Mailer überträgt Anhänge (Dateiname und Inhalt)', async () => {
  const { createResendMailer } = require('../src/mailer');
  const calls = [];
  const mailer = createResendMailer({ apiKey: 're_k', fetch: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '' }; } });
  await mailer.send({ to: 'x@y.ba', subject: 's', text: 't', attachments: [{ filename: 'a.db', content: 'QUJD' }] });
  assert.deepEqual(calls[0].attachments, [{ filename: 'a.db', content: 'QUJD' }]);
});

test('Automatische Sicherung: jeden Sonntag um 22 Uhr Sarajevo, genau einmal; Fehlergrund im Log', async () => {
  const { runScheduledBackup, backupSlot } = require('../src/backup');
  const { getSetting } = require('../src/db');
  const fresh = openDatabase(':memory:');
  const at = (iso) => new Date(iso).getTime();
  // Letzter Termin: Sonntag 22:00 Sarajevo (Sommer- und Winterzeit)
  assert.equal(new Date(backupSlot(at('2026-10-18T20:30:00Z'))).toISOString(), '2026-10-18T20:00:00.000Z');
  assert.equal(new Date(backupSlot(at('2026-10-21T10:00:00Z'))).toISOString(), '2026-10-18T20:00:00.000Z');
  assert.equal(new Date(backupSlot(at('2026-10-25T21:00:00Z'))).toISOString(), '2026-10-25T21:00:00.000Z'); // CET
  assert.equal(new Date(backupSlot(at('2026-10-25T20:59:00Z'))).toISOString(), '2026-10-18T20:00:00.000Z');

  const mails = [];
  let fail = false;
  const mailer = { async send(m) { if (fail) return false; mails.push(m); return true; } };
  const state = {};
  const run = (iso) => runScheduledBackup(fresh, mailer, { now: at(iso), state });
  // Beim ersten Start wird nicht rückwirkend gesendet, wenn der Termin schon über einen Tag zurückliegt
  assert.equal(await run('2026-10-16T10:00:00Z'), 'skipped');
  // Sonntag 21:59 → noch nicht; 22:00 → senden; danach nicht noch einmal
  assert.equal(await run('2026-10-18T19:59:00Z'), 'skipped');
  assert.equal(await run('2026-10-18T20:00:00Z'), 'sent');
  assert.equal(await run('2026-10-18T20:05:00Z'), 'skipped');
  assert.equal(await run('2026-10-19T08:00:00Z'), 'skipped');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'bettertennis.net@gmail.com');
  assert.equal(getSetting(fresh, 'backup_last_slot'), '2026-10-18T20:00:00.000Z');
  // Der Stand ist in der Datenbank gespeichert: auch nach einem Neustart (neuer Zustand) kein doppelter Versand
  assert.equal(await runScheduledBackup(fresh, mailer, { now: at('2026-10-18T20:10:00Z'), state: {} }), 'skipped');

  // Nächster Sonntag (Winterzeit): Versand schlägt fehl → Grund im Log, kein Vermerk, erneuter Versuch nach 30 Minuten
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    fail = true;
    assert.equal(await run('2026-10-25T21:00:00Z'), 'failed');
    assert.ok(errors.some((e) => /Sigurnosna kopija.*nije poslana/i.test(e)), errors.join('\n'));
    assert.equal(await run('2026-10-25T21:10:00Z'), 'skipped'); // noch keine 30 Minuten
    fail = false;
    assert.equal(await run('2026-10-25T21:31:00Z'), 'sent');
  } finally {
    console.error = origError;
  }
  assert.equal(mails.length, 2);
  assert.match(mails[1].text, /25\.10\.2026\. u 22:31/);
  // Server war am Sonntagabend aus: am Montagmorgen wird nachgeholt (innerhalb von 24 Stunden)
  const late = openDatabase(':memory:');
  assert.equal(await runScheduledBackup(late, mailer, { now: at('2026-10-26T07:00:00Z'), state: {} }), 'sent');
  assert.equal(mails.length, 3);
});

test('Admin: Knopf sendet die Backup-Mail sofort; Download „Sigurnosna kopija“ bleibt unverändert', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const home = await admin.request('/admin');
  assert.match(home.text, /href="\/admin\/sigurnosna-kopija"/); // Download wie bisher
  assert.match(home.text, /<form method="post" action="\/admin\/sigurnosna-kopija\/email"/);
  assert.match(home.text, /bettertennis\.net@gmail\.com/);
  sentMails.length = 0;
  const r = await admin.post('/admin/sigurnosna-kopija/email', {}, '/admin');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin');
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, 'bettertennis.net@gmail.com');
  assert.match(sentMails[0].attachments[0].filename, /^bettertennis-\d{4}-\d{2}-\d{2}-\d{4}\.db$/);
  assert.match((await admin.request('/admin')).text, /kopija je poslana na bettertennis\.net@gmail\.com/);
  // Download funktioniert weiter
  const dl = await admin.request('/admin/sigurnosna-kopija');
  assert.equal(dl.status, 200);
  assert.ok(dl.text.startsWith('SQLite format 3'));
  // Nur Admins
  const m = client();
  await m.login('max', 'memberpass1');
  assert.equal((await m.post('/admin/sigurnosna-kopija/email', {}, '/mitglied')).status, 403);
  assert.equal(sentMails.length, 1);
});

test('Admin: fehlgeschlagene Backup-Mail zeigt Hinweis, Grund steht im Log', async () => {
  const fresh = openDatabase(':memory:');
  ensureAdmin(fresh, { email: 'chef@backup.test', password: 'chefpass123' });
  const failing = { async send() { console.error('Resend: slanje nije uspjelo (422): invalid attachment'); return false; } };
  const app = createApp(fresh, { secret: 'b-secret', mailer: failing });
  const srv = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    let cookie = '';
    const req = async (p, opts = {}) => {
      const res = await fetch(url + p, { redirect: 'manual', ...opts, headers: { cookie, ...(opts.headers || {}) } });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { res, text: await res.text() };
    };
    const token = () => req('/login').then(({ text }) => /name="_csrf" value="([^"]+)"/.exec(text)[1]);
    const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });
    await req('/login', form({ _csrf: await token(), username: 'chef@backup.test', password: 'chefpass123' }));
    const t2 = /name="_csrf" value="([^"]+)"/.exec((await req('/admin')).text)[1];
    const r = await req('/admin/sigurnosna-kopija/email', form({ _csrf: t2 }));
    assert.equal(r.res.status, 302);
    assert.match((await req('/admin')).text, /nije poslan/);
    assert.ok(errors.some((e) => /\(422\): invalid attachment/.test(e)));
    assert.ok(errors.some((e) => /Sigurnosna kopija.*nije poslana/i.test(e)));
  } finally {
    console.error = origError;
    srv.close();
  }
});


// ---------------------------------------------------------------- Mails nur auf Knopfdruck: Absage und Aktuelnosti
// Liest die Auswahlliste (Zeilen mit Kästchen, Name, E-Mail/Status).
function recipientRows(text) {
  return [...text.matchAll(/<tr class="recipient-row[^"]*">([\s\S]*?)<\/tr>/g)].map((m) => {
    const row = m[1];
    const box = /<input type="checkbox" name="recipients" value="(\d+)"([^>]*)>/.exec(row);
    return {
      id: box && Number(box[1]),
      disabled: !!box && /disabled/.test(box[2]),
      checked: !!box && /checked/.test(box[2]),
      name: /<td class="recipient-name">([^<]+)<\/td>/.exec(row)[1],
      info: /<td class="recipient-mail">([\s\S]*?)<\/td>/.exec(row)[1].replace(/<[^>]+>/g, '').trim(),
    };
  });
}

function makeMailMember(name, username, email) {
  const id = makeMember(name, username);
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || `${username}@bez-emaila.bettertennis.local`, id);
  return id;
}

test('Absage-Mail: nur auf Knopfdruck, Auswahlliste, optionaler Grund, „bereits informiert“', async () => {
  const a = makeMailMember('Otkaz Prvi', 'otkaz.prvi', 'otkaz.prvi@primjer.ba');
  const b = makeMailMember('Otkaz Drugi', 'otkaz.drugi', 'otkaz.drugi@primjer.ba');
  const c = makeMailMember('Otkaz Treci', 'otkaz.treci', null); // ohne E-Mail
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  // Feste Gruppe mit genau diesen Spielern → ihr Name erscheint in der Mail
  await admin.post('/admin/grupe', { name: 'Grupa Otkaz', member_ids: [a, b, c].map(String) }, '/admin/grupe');
  await admin.post('/admin/termine', {
    kind: 'group', user_id: String(a), member_ids: [String(b), String(c)], date: '2026-10-21', start_time: '17:00', duration_min: '60', price: '10', repeat: '1',
  }, '/admin/termine');
  const lesson = db.prepare("SELECT * FROM lessons WHERE user_id = ? AND date = '2026-10-21'").get(a);
  const page = `/admin/termine/${lesson.id}/obavijest-otkazivanje`;
  const week = '/admin/termine?woche=2026-10-19';

  // Vor dem Absagen kein Knopf, keine Mail-Seite
  assert.doesNotMatch((await admin.request(week)).text, new RegExp(`href="${page}"`));
  assert.equal((await admin.request(page)).status, 302);

  // Absagen wie bisher – dabei geht KEINE Mail raus, Termin bleibt sichtbar als „Otkazan“
  sentMails.length = 0;
  await admin.post(`/admin/termine/${lesson.id}/status`, { status: 'cancelled', back: week }, week);
  assert.equal(sentMails.length, 0);
  assert.deepEqual(db.prepare('SELECT cancelled FROM lessons WHERE group_id = ?').all(lesson.group_id).map((r) => r.cancelled), [1, 1, 1]);
  const weekText = (await admin.request(week)).text;
  assert.match(weekText, /Otkazan/);
  assert.match(weekText, new RegExp(`<a class="btn btn-ghost btn-sm" href="${page}">Pošalji e-mail o otkazivanju</a>`));

  // Auswahlliste: alle Teilnehmer, nichts angehakt, ohne E-Mail nicht wählbar
  let r = await admin.request(page);
  assert.equal(r.status, 200);
  assert.match(r.text, /Srijeda, 21\.10\.2026\./);
  assert.match(r.text, /17:00–18:00/);
  assert.match(r.text, /<input type="checkbox" data-select-all>/);
  assert.match(r.text, /<textarea name="message"/);
  let rows = recipientRows(r.text);
  assert.deepEqual(rows.map((x) => x.name), ['Otkaz Drugi', 'Otkaz Prvi', 'Otkaz Treci']);
  assert.ok(rows.every((x) => !x.checked));
  assert.deepEqual(rows.map((x) => x.info), ['otkaz.drugi@primjer.ba', 'otkaz.prvi@primjer.ba', 'nije dostupno']);
  assert.deepEqual(rows.map((x) => x.disabled), [false, false, true]);

  // Senden an A ohne Grund → neutrale, freundliche Mail auf Bosnisch
  r = await admin.post(page, { recipients: String(a), message: '   ' }, page);
  assert.equal(r.status, 302);
  assert.equal(sentMails.length, 1);
  let mail = sentMails[0];
  assert.equal(mail.to, 'otkaz.prvi@primjer.ba');
  assert.match(mail.subject, /Otkazan trening/);
  assert.match(mail.text, /Zdravo Otkaz Prvi/);
  assert.match(mail.text, /Srijeda, 21\.10\.2026\./);
  assert.match(mail.text, /17:00–18:00/);
  assert.match(mail.text, /Grupa Otkaz/);
  assert.match(mail.text, /Hvala na razumijevanju/);
  assert.doesNotMatch(mail.text, /Napomena|Razlog/);
  assert.doesNotMatch(mail.text, /Otkaz Drugi|Otkaz Treci/); // keine Namen anderer Spieler
  assert.ok(mail.html.includes('21.10.2026.'));

  // A ist jetzt „bereits informiert“ und nicht mehr wählbar
  rows = recipientRows((await admin.request(page)).text);
  assert.deepEqual(rows.map((x) => [x.name, x.disabled]), [['Otkaz Drugi', false], ['Otkaz Prvi', true], ['Otkaz Treci', true]]);
  assert.match(rows[1].info, /već obaviješten/);

  // Alle drei auswählen + Grund → nur B bekommt eine Mail (A schon informiert, C ohne E-Mail)
  await admin.post(page, { recipients: [a, b, c].map(String), message: 'Zbog kiše. Zamjenski termin u četvrtak u 17 h.' }, page);
  assert.equal(sentMails.length, 2);
  mail = sentMails[1];
  assert.equal(mail.to, 'otkaz.drugi@primjer.ba');
  assert.match(mail.text, /Napomena: Zbog kiše\. Zamjenski termin u četvrtak u 17 h\./);
  assert.ok(mail.html.includes('Zbog kiše.'));

  // Einzeltraining: nur der eine Spieler; fremde IDs werden ignoriert
  await admin.post('/admin/termine', { kind: 'individual', user_id: String(b), date: '2026-10-22', start_time: '09:00', duration_min: '60', repeat: '1' }, '/admin/termine');
  const single = db.prepare("SELECT * FROM lessons WHERE user_id = ? AND date = '2026-10-22'").get(b);
  await admin.post(`/admin/termine/${single.id}/status`, { status: 'cancelled' }, week);
  const singlePage = `/admin/termine/${single.id}/obavijest-otkazivanje`;
  assert.deepEqual(recipientRows((await admin.request(singlePage)).text).map((x) => x.name), ['Otkaz Drugi']);
  await admin.post(singlePage, { recipients: [String(a), String(b)] }, singlePage);
  assert.equal(sentMails.length, 3);
  assert.equal(sentMails[2].to, 'otkaz.drugi@primjer.ba');
  assert.match(sentMails[2].text, /Individualni trening/);
  assert.match(sentMails[2].text, /Četvrtak, 22\.10\.2026\./);

  // Nichts ausgewählt → keine Mail, Hinweis
  const none = await admin.post(page, {}, page);
  assert.equal(none.status, 302);
  assert.equal(sentMails.length, 3);

  // Nur Admins
  const m = client();
  await m.login('otkaz.prvi', 'memberpass1');
  assert.equal((await m.request(page)).status, 403);
  assert.equal((await m.post(page, { recipients: String(b) }, '/mitglied')).status, 403);
  assert.equal(sentMails.length, 3);
});

test('Absage-Mail: fehlgeschlagener Versand → Grund im Log, Empfänger bleibt wählbar', async () => {
  const a = makeMailMember('Greska Mejl', 'greska.mejl', 'greska.mejl@primjer.ba');
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  await admin.post('/admin/termine', { kind: 'individual', user_id: String(a), date: '2026-10-23', start_time: '10:00', duration_min: '60', repeat: '1' }, '/admin/termine');
  const lesson = db.prepare("SELECT * FROM lessons WHERE user_id = ? AND date = '2026-10-23'").get(a);
  await admin.post(`/admin/termine/${lesson.id}/status`, { status: 'cancelled' }, '/admin/termine');
  const page = `/admin/termine/${lesson.id}/obavijest-otkazivanje`;
  const errors = [];
  const orig = console.error;
  console.error = (...x) => errors.push(x.join(' '));
  testMailer.fail = true;
  try {
    await admin.post(page, { recipients: String(a) }, page);
  } finally {
    testMailer.fail = false;
    console.error = orig;
  }
  assert.ok(errors.some((e) => /test-greška za greska\.mejl@primjer\.ba/.test(e)));
  assert.ok(errors.some((e) => /E-mail o otkazivanju nije poslan.*greska\.mejl@primjer\.ba/.test(e)), errors.join('\n'));
  const after = await admin.request(page);
  assert.match(after.text, /nije poslan/);
  assert.deepEqual(recipientRows(after.text).map((x) => x.disabled), [false]);
});

test('Aktuelnosti per Mail: nur auf Knopfdruck, Auswahl aller Mitglieder, Titel und Text, „bereits informiert“', async () => {
  const a = makeMailMember('Vijest Prvi', 'vijest.prvi', 'vijest.prvi@primjer.ba');
  const b = makeMailMember('Vijest Drugi', 'vijest.drugi', 'vijest.drugi@primjer.ba');
  makeMailMember('Vijest Bez', 'vijest.bez', null);
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  sentMails.length = 0;
  // Erstellen wie bisher – ohne Mail
  const created = await admin.post('/admin/aktuelnosti', { title: 'Zimski turnir', body: 'Turnir je u subotu u 10 h.\nPrijave do četvrtka.', audience: 'all' }, '/admin/aktuelnosti');
  assert.equal(created.status, 302);
  assert.equal(sentMails.length, 0);
  const news = db.prepare("SELECT * FROM news WHERE title = 'Zimski turnir'").get();
  const page = `/admin/aktuelnosti/${news.id}/email`;
  // Knopf in der Liste (nach dem Erstellen) und auf der Detailseite
  const list = await admin.request('/admin/aktuelnosti');
  assert.match(list.text, new RegExp(`<a class="btn btn-ghost btn-sm" href="${page}">Pošalji e-mailom</a>`));
  const detail = await admin.request(`/admin/aktuelnosti/${news.id}`);
  assert.equal(detail.status, 200);
  assert.match(detail.text, /Zimski turnir/);
  assert.match(detail.text, /Turnir je u subotu u 10 h\./);
  assert.match(detail.text, new RegExp(`href="${page}"`));

  // Auswahl: alle aktiven Mitglieder (ohne Kinder-Konten), nichts angehakt
  let r = await admin.request(page);
  assert.equal(r.status, 200);
  let rows = recipientRows(r.text);
  const memberCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member' AND active = 1 AND parent_id IS NULL").get().n;
  assert.equal(rows.length, memberCount);
  assert.ok(rows.every((x) => !x.checked));
  const bez = rows.find((x) => x.name === 'Vijest Bez');
  assert.equal(bez.info, 'nije dostupno');
  assert.equal(bez.disabled, true);
  assert.match(r.text, /<input type="checkbox" data-select-all>/);
  assert.doesNotMatch(r.text, /<textarea/); // hier kein Zusatztext nötig

  await admin.post(page, { recipients: [String(a), String(b)] }, page);
  assert.equal(sentMails.length, 2);
  assert.deepEqual(sentMails.map((m) => m.to).sort(), ['vijest.drugi@primjer.ba', 'vijest.prvi@primjer.ba']);
  for (const m of sentMails) {
    assert.match(m.subject, /Zimski turnir/);
    assert.match(m.text, /Turnir je u subotu u 10 h\.\nPrijave do četvrtka\./);
    assert.match(m.text, /Aktuelnosti/);
    assert.ok(m.html.includes('Zimski turnir'));
  }
  // Bereits informiert → nicht mehr wählbar, kein doppelter Versand
  rows = recipientRows((await admin.request(page)).text);
  for (const name of ['Vijest Prvi', 'Vijest Drugi']) {
    const row = rows.find((x) => x.name === name);
    assert.equal(row.disabled, true);
    assert.match(row.info, /već obaviješten/);
  }
  await admin.post(page, { recipients: [String(a)] }, page);
  assert.equal(sentMails.length, 2);
  // Bisherige Funktion unverändert: Aktuelnost im Postfach der Mitglieder
  const m = client();
  await m.login('vijest.prvi', 'memberpass1');
  assert.match((await m.request('/mitglied/aktuelnosti')).text, /Zimski turnir/);
  assert.equal((await m.request(page)).status, 403);
  // „Alle auswählen“ wählt nur wählbare Kästchen (Skript)
  const js = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /data-select-all/);
  assert.match(js, /:not\(:disabled\)/);
});

// ---------------------------------------------------------------- Anwesenheits-Status und Berechnungs-Spalte
function playerRows(text) {
  return [...text.matchAll(/<tr class="player-row" data-row="(\d+)">([\s\S]*?)<\/tr>/g)].map((m) => ({
    row: Number(m[1]),
    name: /<td class="player-name">([^<]+)<\/td>/.exec(m[2])[1],
    status: /<option value="([^"]*)" selected>/.exec(m[2])?.[1] ?? null,
    billing: /<td class="player-billing">([\s\S]*?)<\/td>/.exec(m[2])[1].replace(/\s+/g, ' ').trim(),
    html: m[2],
  }));
}

test('Termini → Uredi: Status (Dokumentation) und Berechnung pro Spieler; Status ändert die Abrechnung nie', async () => {
  const a = makeMember('Status Prvi', 'status.prvi', { rate: 4000 });
  const b = makeMember('Status Drugi', 'status.drugi', { rate: 4000 });
  const c = makeMember('Status Treci', 'status.treci', { rate: 4000 });
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  // C rechnet im Oktober mit „Raspored s prikazom, bez obračuna“ ab
  await admin.post(`/admin/abrechnung/${c}/nacin`, { month: '2026-10', billing_mode: 'display' }, `/admin/abrechnung/${c}?monat=2026-10`);
  await admin.post('/admin/termine', {
    kind: 'group', user_id: String(a), member_ids: [String(b), String(c)], date: '2026-10-27', start_time: '18:00', duration_min: '60', price: '25', repeat: '1',
  }, '/admin/termine');
  const lesson = db.prepare("SELECT * FROM lessons WHERE user_id = ? AND date = '2026-10-27'").get(a);
  const rowOf = (uid) => db.prepare('SELECT * FROM lessons WHERE group_id = ? AND user_id = ?').get(lesson.group_id, uid);
  const edit = `/admin/termine/${lesson.id}`;
  const { monthlyStatement } = require('../src/billing');
  const total = (uid) => monthlyStatement(db, db.prepare('SELECT * FROM users WHERE id = ?').get(uid), '2026-10').total;
  const before = { a: total(a), b: total(b), c: total(c) };

  // Standard: kein Status („–“), alle in der Berechnung (grüner Haken), Spalte nur bei „Prema rasporedu“
  let page = await admin.request(edit);
  assert.match(page.text, /<th>Status<\/th>/);
  assert.match(page.text, /<th>Obračun<\/th>/);
  let rows = playerRows(page.text);
  assert.deepEqual(rows.map((r) => r.name), ['Status Drugi', 'Status Prvi', 'Status Treci']);
  assert.ok(rows.every((r) => r.status === ''));
  assert.match(rows[0].html, /<option value="" selected>–<\/option>/);
  for (const label of ['prisutan', 'nije došao/la', 'bolestan/na', 'povrijeđen/a', 'otkazao/la na vrijeme', 'otkazao/la prekasno', 'drugi razlog']) {
    assert.ok(rows[0].html.includes(`>${label}</option>`), label);
  }
  assert.match(rows[0].billing, /bill-mark is-on/);
  assert.match(rows[0].billing, /Ne uključuj u obračun/);
  assert.equal(rows[2].billing, ''); // C: „prikaz bez obračuna“ → keine Berechnungs-Spalte
  assert.ok([a, b, c].every((uid) => rowOf(uid).attendance === null && rowOf(uid).billable === 1));

  // Status setzen (jeder Status), ändern, zurücksetzen – Abrechnung bleibt immer gleich
  const setStatus = (uid, attendance, note = '') => admin.post(`${edit}/igrac/${rowOf(uid).id}/status`, { attendance, note }, edit);
  for (const st of ['present', 'no_show', 'sick', 'injured', 'cancelled_on_time', 'cancelled_late']) {
    assert.equal((await setStatus(a, st)).status, 302);
    assert.equal(rowOf(a).attendance, st);
    assert.equal(total(a), before.a);
  }
  await setStatus(b, 'other', 'kiša');
  assert.equal(rowOf(b).attendance, 'other');
  assert.equal(rowOf(b).attendance_note, 'kiša');
  await setStatus(c, 'sick', 'ignoriert');
  assert.equal(rowOf(c).attendance_note, null); // Notiz nur bei „drugi razlog“
  assert.equal((await setStatus(a, 'erfunden')).status, 400);
  await setStatus(a, '');
  assert.equal(rowOf(a).attendance, null);
  await setStatus(a, 'present');
  assert.deepEqual([total(a), total(b), total(c)], [before.a, before.b, before.c]);
  rows = playerRows((await admin.request(edit)).text);
  assert.deepEqual(rows.map((r) => r.status), ['other', 'present', 'sick']);
  assert.match(rows[0].html, /name="note"[^>]*value="kiša"/);

  // Berechnung: nur durch Klick ausnehmen, erneuter Klick nimmt wieder auf; unabhängig vom Status
  const toggle = (uid) => admin.post(`${edit}/igrac/${rowOf(uid).id}/obracun`, {}, edit);
  assert.equal((await toggle(a)).status, 302);
  assert.equal(rowOf(a).billable, 0);
  assert.equal(rowOf(a).attendance, 'present');
  assert.equal(total(a), before.a - 2500);
  rows = playerRows((await admin.request(edit)).text);
  assert.match(rows[1].billing, /bill-mark is-off/);
  assert.match(rows[1].billing, /Uključi u obračun/);
  await toggle(a);
  assert.equal(rowOf(a).billable, 1);
  assert.equal(total(a), before.a);
  // Bei „prikaz bez obračuna“ gibt es keinen Berechnungs-Schalter
  assert.equal((await toggle(c)).status, 400);
  assert.equal(rowOf(c).billable, 1);

  // Speichern des Termins (Uredi → Sačuvaj) behält Status und Berechnung je Spieler
  await toggle(b);
  await admin.post(edit, {
    kind: 'group', user_id: String(a), member_ids: [String(b), String(c)], date: '2026-10-27', start_time: '18:30', duration_min: '60', price: '25', status: 'done',
  }, edit);
  assert.equal(rowOf(a).attendance, 'present');
  assert.equal(rowOf(b).attendance, 'other');
  assert.equal(rowOf(b).attendance_note, 'kiša');
  assert.equal(rowOf(b).billable, 0);
  assert.equal(rowOf(c).attendance, 'sick');
  assert.equal(rowOf(a).start_time, '18:30');
  // Nur Admins
  const m = client();
  await m.login('status.prvi', 'memberpass1');
  assert.equal((await m.post(`/admin/termine/${rowOf(a).id}/igrac/${rowOf(a).id}/status`, { attendance: 'sick' }, '/mitglied')).status, 403);
  assert.equal(rowOf(a).attendance, 'present');
});

test('Iznosi → Detalji: Status je Einheit, Haken bei „Prema rasporedu“, Monats-Zusammenfassung; Mitglieder sehen davon nichts', async () => {
  const a = makeMember('Pregled Prvi', 'pregled.prvi', { rate: 3000 });
  const d = makeMember('Pregled Prikaz', 'pregled.prikaz', { rate: 3000 });
  const r = makeMember('Pregled Rucno', 'pregled.rucno', { rate: 3000 });
  const add = (uid, date, extra = {}) => db.prepare(
    `INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents, attendance, attendance_note, billable)
     VALUES (?, ?, '10:00', 60, 3000, ?, ?, ?)`
  ).run(uid, date, extra.attendance ?? null, extra.note ?? null, extra.billable ?? 1);
  for (const uid of [a, d, r]) {
    add(uid, '2026-10-05', { attendance: 'present' });
    add(uid, '2026-10-06', { attendance: 'present' });
    add(uid, '2026-10-07', { attendance: 'sick', billable: 0 });
    add(uid, '2026-10-08', { attendance: 'other', note: 'turnir' });
    add(uid, '2026-10-09'); // ohne Status
    db.prepare("INSERT INTO payments (user_id, month, released) VALUES (?, '2026-10', 1)").run(uid);
  }
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  await admin.post(`/admin/abrechnung/${d}/nacin`, { month: '2026-10', billing_mode: 'display' }, `/admin/abrechnung/${d}?monat=2026-10`);
  await admin.post(`/admin/abrechnung/${r}/nacin`, { month: '2026-10', billing_mode: 'manual' }, `/admin/abrechnung/${r}?monat=2026-10`);

  // „Prema rasporedu“: Status + Haken; ausgenommene Einheit zählt nicht (4 × 30 KM statt 5 ×)
  const pa = (await admin.request(`/admin/abrechnung/${a}?monat=2026-10`)).text;
  assert.match(pa, /<th>Status<\/th>/);
  assert.match(pa, /<th>Obračun<\/th>/);
  assert.equal((pa.match(/bill-mark is-on/g) || []).length, 4);
  assert.equal((pa.match(/bill-mark is-off/g) || []).length, 1);
  assert.match(pa, /<td class="attendance">bolestan\/na<\/td>/);
  assert.match(pa, /<td class="attendance">drugi razlog: turnir<\/td>/);
  assert.match(pa, /<td class="attendance">–<\/td>/);
  assert.match(pa, /Status u mjesecu: 2 prisutan, 1 bolestan\/na, 1 drugi razlog/);
  assert.match(pa, /120,00\sKM/);
  // „Raspored s prikazom, bez obračuna“: Status ja, Haken nein
  const pd = (await admin.request(`/admin/abrechnung/${d}?monat=2026-10`)).text;
  assert.match(pd, /<th>Status<\/th>/);
  assert.doesNotMatch(pd, /<th>Obračun<\/th>|bill-mark/);
  assert.match(pd, /Status u mjesecu: 2 prisutan, 1 bolestan\/na, 1 drugi razlog/);
  // „Ručni unos“: unverändert, kein Status
  const pr = (await admin.request(`/admin/abrechnung/${r}?monat=2026-10`)).text;
  assert.doesNotMatch(pr, /<th>Status<\/th>|bill-mark|Status u mjesecu/);

  // Mitglied sieht weder Status noch Haken (Abrechnung und Wochenplan)
  const m = client();
  await m.login('pregled.prvi', 'memberpass1');
  for (const path of ['/mitglied/abrechnung?monat=2026-10', '/mitglied?woche=2026-10-05']) {
    const t = (await m.request(path)).text;
    // (Die Spalte „Status“ im Zahlungsüberblick der Mitglieder gab es schon immer – gemeint ist hier die Anwesenheit.)
    assert.doesNotMatch(t, /bolestan|prisutan|drugi razlog|turnir|bill-mark|class="attendance"|<th>Obračun<\/th>/, path);
  }
});

test('Bestehende Termine: nach dem Update ohne Status und weiterhin in der Berechnung', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-att-'));
  const file = path.join(dir, 'alt.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, phone TEXT,
                password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', hourly_rate_cents INTEGER NOT NULL DEFAULT 0,
                monthly_fee_cents INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
              CREATE TABLE lessons (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL,
                duration_min INTEGER NOT NULL, court TEXT, note TEXT, price_cents INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    old.prepare("INSERT INTO users (name, email, password_hash) VALUES ('Stari', 'stari@x.ba', 'h')").run();
    old.prepare("INSERT INTO lessons (user_id, date, start_time, duration_min, price_cents) VALUES (1, '2026-10-05', '10:00', 60, 4000)").run();
    old.close();
    const migrated = openDatabase(file);
    const row = migrated.prepare('SELECT * FROM lessons').get();
    assert.equal(row.attendance, null);
    assert.equal(row.attendance_note, null);
    assert.equal(row.billable, 1);
    assert.equal(row.price_cents, 4000);
    migrated.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- Privatstunden: freie Termine und Anfragen
// Liest die freien Termine aus der Mitgliederseite.
function privateSlots(text) {
  return [...text.matchAll(/<li class="private-slot" data-slot="(\d+)">([\s\S]*?)<\/li>/g)].map((m) => ({
    id: Number(m[1]),
    text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    html: m[2],
  }));
}

test('Privatstunden: Admin legt freie Termine an, blockiert/löscht sie; Mitglieder sehen nur freie, künftige (Sarajevo-Zeit)', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const base = '/admin/privatni-casovi';
  assert.equal((await admin.request(base)).status, 200);
  assert.match((await admin.request('/admin')).text, /href="\/admin\/privatni-casovi"/);
  const add = (date, start, end) => admin.post(base, { date, start_time: start, end_time: end }, base);
  // Ungültig: Ende vor Beginn, falsches Datum
  assert.equal((await add('2026-10-20', '11:00', '10:00')).status, 400);
  assert.equal((await add('2026-13-40', '10:00', '11:00')).status, 400);
  for (const [d, s, e] of [['2026-10-20', '10:00', '11:00'], ['2026-10-12', '17:00', '18:30'], ['2026-10-09', '10:30', '11:30'],
    ['2026-10-09', '09:30', '10:30'], ['2026-10-08', '10:00', '11:00'], ['2026-10-21', '08:00', '09:00']]) {
    assert.equal((await add(d, s, e)).status, 302);
  }
  const slot = (d, s) => db.prepare('SELECT * FROM private_slots WHERE date = ? AND start_time = ?').get(d, s);
  // Einen Termin blockieren
  await admin.post(`${base}/${slot('2026-10-21', '08:00').id}/blokiraj`, {}, base);
  assert.equal(slot('2026-10-21', '08:00').blocked, 1);

  const id = makeMember('Privat Clan', 'privat.clan');
  const m = client();
  await m.login('privat.clan', 'memberpass1');
  const home = await m.request('/mitglied');
  assert.match(home.text, /href="\/mitglied\/privatni-cas"[^>]*>Zatraži privatni čas</);
  let page = await m.request('/mitglied/privatni-cas');
  assert.equal(page.status, 200);
  // Jetzt: Fr 9.10.2026, 10:00 Sarajevo → 09:30 hat schon begonnen, 08.10. vorbei, 21.10. blockiert
  assert.deepEqual(privateSlots(page.text).map((s) => s.id), [slot('2026-10-09', '10:30').id, slot('2026-10-12', '17:00').id, slot('2026-10-20', '10:00').id]);
  assert.match(privateSlots(page.text)[1].text, /Ponedjeljak, 12\.10\.2026\. 17:00–18:30/);
  // Blockierung aufheben → wieder sichtbar
  await admin.post(`${base}/${slot('2026-10-21', '08:00').id}/odblokiraj`, {}, base);
  assert.equal(privateSlots((await m.request('/mitglied/privatni-cas')).text).length, 4);
  // Sobald die Startzeit erreicht ist (Sarajevo), verschwindet der Termin
  await atTime('2026-10-09T10:29:00+02:00', async () => {
    const c = client();
    await c.login('privat.clan', 'memberpass1');
    assert.ok(privateSlots((await c.request('/mitglied/privatni-cas')).text).some((s) => s.id === slot('2026-10-09', '10:30').id));
  });
  await atTime('2026-10-09T10:30:00+02:00', async () => {
    const c = client();
    await c.login('privat.clan', 'memberpass1');
    assert.ok(!privateSlots((await c.request('/mitglied/privatni-cas')).text).some((s) => s.id === slot('2026-10-09', '10:30').id));
  });
  // Löschen
  await admin.post(`${base}/${slot('2026-10-21', '08:00').id}/obrisi`, {}, base);
  assert.equal(slot('2026-10-21', '08:00'), undefined);
  // Keine freien Termine → Hinweis
  db.prepare('UPDATE private_slots SET blocked = 1').run();
  assert.match((await m.request('/mitglied/privatni-cas')).text, /Trenutno nema slobodnih termina\./);
  db.prepare('UPDATE private_slots SET blocked = 0').run();
  // Nicht sichtbar für Startseite, Kinder-Konten, Elternkonten, Gäste; Admin-Bereich nur für Admin
  assert.doesNotMatch((await client().request('/')).text, /privatni-cas|Zatraži privatni čas/);
  assert.equal((await client().request('/mitglied/privatni-cas')).status, 302);
  await m.post('/mitglied/djeca', { name: 'Privat Dijete', username: 'privat.kid', password: 'kid-pass-123' }, '/mitglied/djeca');
  const kid = client();
  await kid.login('privat.kid', 'kid-pass-123');
  assert.doesNotMatch((await kid.request('/mitglied')).text, /privatni-cas/);
  assert.equal((await kid.request('/mitglied/privatni-cas')).status, 403);
  await createParentAccount(admin, { name: 'Privat Roditelj', username: 'privat.roditelj', password: 'roditelj-1', players: [id] });
  const parent = client();
  await parent.login('privat.roditelj', 'roditelj-1');
  assert.equal((await parent.request('/mitglied/privatni-cas')).location, '/roditelj');
  assert.equal((await m.request(base)).status, 403);
});

test('Privatstunden: Anfrage mit Sicherheitsabfrage, Dankestext, Admin-Mail; Termin bleibt frei; keine Doppelanfrage', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  const base = '/admin/privatni-casovi';
  await admin.post(base, { date: '2026-10-28', start_time: '16:00', end_time: '17:00' }, base);
  const slot = db.prepare("SELECT * FROM private_slots WHERE date = '2026-10-28'").get();
  const a = makeMember('Upit Prvi', 'upit.prvi');
  makeMember('Upit Drugi', 'upit.drugi');
  const m = client();
  await m.login('upit.prvi', 'memberpass1');
  const list = await m.request('/mitglied/privatni-cas');
  const confirmUrl = `/mitglied/privatni-cas/${slot.id}`;
  assert.match(privateSlots(list.text).find((s) => s.id === slot.id).html, new RegExp(`href="${confirmUrl}"`));
  // Sicherheitsabfrage
  const confirm = await m.request(confirmUrl);
  assert.equal(confirm.status, 200);
  assert.match(confirm.text, /Želite li poslati upit za ovaj privatni čas\?/);
  assert.match(confirm.text, /Srijeda, 28\.10\.2026\. 16:00–17:00/);
  assert.match(confirm.text, /<button class="btn btn-primary" type="submit">Da, pošalji upit<\/button>/);
  assert.match(confirm.text, /<a class="btn btn-ghost" href="\/mitglied\/privatni-cas">Ne, slučajno sam kliknuo<\/a>/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_requests').get().n, 0); // nur Anzeigen speichert nichts

  sentMails.length = 0;
  const sent = await m.post(confirmUrl, {}, confirmUrl);
  assert.equal(sent.status, 302);
  assert.equal(sent.location, '/mitglied/privatni-cas');
  const after = await m.request('/mitglied/privatni-cas');
  assert.match(after.text, /Hvala! Trener će vas uskoro kontaktirati\./);
  const req1 = db.prepare('SELECT * FROM private_requests WHERE user_id = ?').get(a);
  assert.ok(req1);
  assert.equal(req1.slot_id, slot.id);
  assert.equal(req1.done, 0);
  // Mail nur an den Admin, nicht an das Mitglied
  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, 'bettertennis.net@gmail.com');
  assert.match(sentMails[0].text, /Upit Prvi/);
  assert.match(sentMails[0].text, /28\.10\.2026\. 16:00–17:00/);
  // Termin bleibt sichtbar; als angefragt markiert, keine Doppelanfrage
  const mine = privateSlots(after.text).find((s) => s.id === slot.id);
  assert.match(mine.text, /Upit poslan/);
  await m.post(confirmUrl, {}, '/mitglied/privatni-cas');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_requests WHERE user_id = ?').get(a).n, 1);
  assert.equal(sentMails.length, 1);
  // Ein anderes Mitglied kann denselben Termin anfragen
  const o = client();
  await o.login('upit.drugi', 'memberpass1');
  assert.ok(privateSlots((await o.request('/mitglied/privatni-cas')).text).some((s) => s.id === slot.id));
  await o.post(confirmUrl, {}, confirmUrl);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_requests WHERE slot_id = ?').get(slot.id).n, 2);
  assert.equal(sentMails.length, 2);

  // Admin: offene und erledigte Anfragen getrennt; abhaken und zurück
  let adminPage = (await admin.request(base)).text;
  const openPart = () => /<section class="card" id="otvoreni-upiti">([\s\S]*?)<\/section>/.exec(adminPage)[1];
  const donePart = () => /<section class="card" id="zavrseni-upiti">([\s\S]*?)<\/section>/.exec(adminPage)[1];
  assert.match(openPart(), /Upit Prvi[\s\S]*28\.10\.2026\. 16:00–17:00[\s\S]*09\.10\.2026\. u 10:00/);
  assert.match(openPart(), /Upit Drugi/);
  assert.doesNotMatch(donePart(), /Upit Prvi/);
  await admin.post(`${base}/upit/${req1.id}/zavrseno`, {}, base);
  adminPage = (await admin.request(base)).text;
  assert.doesNotMatch(openPart(), /Upit Prvi/);
  assert.match(donePart(), /Upit Prvi/);
  await admin.post(`${base}/upit/${req1.id}/otvoreno`, {}, base);
  adminPage = (await admin.request(base)).text;
  assert.match(openPart(), /Upit Prvi/);

  // Blockiert oder begonnen → keine Anfrage mehr möglich
  await admin.post(`${base}/${slot.id}/blokiraj`, {}, base);
  const p = client();
  makeMember('Upit Treci', 'upit.treci');
  await p.login('upit.treci', 'memberpass1');
  assert.equal((await p.post(confirmUrl, {}, '/mitglied/privatni-cas')).status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM private_requests r JOIN users u ON u.id = r.user_id WHERE u.username = 'upit.treci'").get().n, 0);
  assert.match((await p.request('/mitglied/privatni-cas')).text, /više nije dostupan/);
  await admin.post(`${base}/${slot.id}/odblokiraj`, {}, base);
  await atTime('2026-10-28T16:00:00+01:00', async () => {
    const q = client();
    await q.login('upit.treci', 'memberpass1');
    await q.post(confirmUrl, {}, '/mitglied/privatni-cas');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM private_requests r JOIN users u ON u.id = r.user_id WHERE u.username = 'upit.treci'").get().n, 0);
  });
  // Termin löschen: Anfragen bleiben mit Datum/Uhrzeit sichtbar
  await admin.post(`${base}/${slot.id}/obrisi`, {}, base);
  adminPage = (await admin.request(base)).text;
  assert.match(openPart(), /Upit Prvi[\s\S]*28\.10\.2026\. 16:00–17:00/);
  // Keine automatische Übernahme in den Trainingsplan
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE date = '2026-10-28' AND start_time = '16:00'").get().n, 0);
});

test('Privatstunden: fehlgeschlagene Admin-Benachrichtigung → Anfrage trotzdem gespeichert, Grund im Log', async () => {
  const admin = client();
  await admin.login('admin@test.de', 'adminpass123');
  await admin.post('/admin/privatni-casovi', { date: '2026-10-29', start_time: '15:00', end_time: '16:00' }, '/admin/privatni-casovi');
  const slot = db.prepare("SELECT * FROM private_slots WHERE date = '2026-10-29'").get();
  makeMember('Upit Greska', 'upit.greska');
  const m = client();
  await m.login('upit.greska', 'memberpass1');
  const errors = [];
  const orig = console.error;
  console.error = (...x) => errors.push(x.join(' '));
  testMailer.fail = true;
  try {
    await m.post(`/mitglied/privatni-cas/${slot.id}`, {}, `/mitglied/privatni-cas/${slot.id}`);
  } finally {
    testMailer.fail = false;
    console.error = orig;
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_requests WHERE slot_id = ?').get(slot.id).n, 1);
  assert.match((await m.request('/mitglied/privatni-cas')).text, /Hvala! Trener će vas uskoro kontaktirati\./);
  assert.ok(errors.some((e) => /Obavijest o upitu za privatni čas nije poslana/.test(e)), errors.join('\n'));
});

// ---------------------------------------------------------------- E-Mail-Fenster nach dem Login
const EMAIL_POPUP_TEXT = 'Molimo unesite svoju e-mail adresu kako biste mogli sami resetovati lozinku i primati važne informacije o treninzima.';
const hasEmailPopup = (text) => /id="email-prozor"/.test(text);
function makeMemberWithoutEmail(name, username) {
  const id = makeMember(name, username);
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(`${username}@bez-emaila.bettertennis.local`, id);
  return id;
}

test('E-Mail-Fenster: erscheint höchstens bei den ersten drei Logins ohne E-Mail; „Kasnije“ schließt es; Hinweis bleibt', async () => {
  makeMemberWithoutEmail('Prozor Clan', 'prozor.clan');
  for (let i = 1; i <= 3; i++) {
    const m = client();
    assert.equal((await m.login('prozor.clan', 'memberpass1')).location, '/mitglied');
    const home = await m.request('/mitglied');
    assert.ok(hasEmailPopup(home.text), `Login ${i}: Fenster fehlt`);
    assert.ok(home.text.includes(EMAIL_POPUP_TEXT));
    assert.match(home.text, /<input[^>]*name="email"[^>]*type="email"/);
    assert.match(home.text, /<button class="btn btn-primary" type="submit">Spremi<\/button>/);
    assert.match(home.text, /<button class="btn btn-ghost" type="submit">Kasnije<\/button>/);
    // Der bisherige Hinweis bleibt unverändert
    assert.match(home.text, /<a class="notice notice-link" href="\/mitglied\/moji-podaci">✉️ Molimo unesi svoju e-mail adresu kako bi mogao\/la sam\/a resetovati lozinku i primati važne informacije o treninzima\. Unesi e-mail →<\/a>/);
    // „Kasnije“ schließt das Fenster für diese Anmeldung
    const later = await m.post('/mitglied/email-prozor/kasnije', {}, '/mitglied');
    assert.equal(later.status, 302);
    assert.equal(later.location, '/mitglied');
    const again = await m.request('/mitglied');
    assert.ok(!hasEmailPopup(again.text));
    assert.match(again.text, /notice-link" href="\/mitglied\/moji-podaci"/);
  }
  // Vierter Login: kein Fenster mehr, der Hinweis bleibt
  const m4 = client();
  await m4.login('prozor.clan', 'memberpass1');
  const home4 = await m4.request('/mitglied');
  assert.ok(!hasEmailPopup(home4.text));
  assert.match(home4.text, /notice-link" href="\/mitglied\/moji-podaci"/);
  assert.equal(db.prepare("SELECT email FROM users WHERE username = 'prozor.clan'").get().email, 'prozor.clan@bez-emaila.bettertennis.local');
});

test('E-Mail-Fenster: „Spremi“ speichert die Mail (Prüfung wie bisher), danach erscheint es nie wieder', async () => {
  makeMemberWithoutEmail('Prozor Dva', 'prozor.dva');
  makeMember('Prozor Zauzet', 'prozor.zauzet'); // hat prozor.zauzet@kids-test.de
  const m = client();
  await m.login('prozor.dva', 'memberpass1');
  assert.ok(hasEmailPopup((await m.request('/mitglied')).text));
  // Ungültige oder bereits vergebene Adresse → Fehler im Fenster, nichts gespeichert
  for (const email of ['kein-mail', 'prozor.zauzet@kids-test.de']) {
    const bad = await m.post('/mitglied/email-prozor', { email }, '/mitglied');
    assert.equal(bad.location, '/mitglied');
    const page = await m.request('/mitglied');
    assert.ok(hasEmailPopup(page.text));
    assert.match(page.text, /ispravnu e-mail adresu|već koristi/);
  }
  assert.match(db.prepare("SELECT email FROM users WHERE username = 'prozor.dva'").get().email, /bez-emaila/);
  // Gültig → gespeichert, Fenster und Hinweis weg
  const ok = await m.post('/mitglied/email-prozor', { email: 'Prozor.Dva@Primjer.ba ' }, '/mitglied');
  assert.equal(ok.location, '/mitglied');
  assert.equal(db.prepare("SELECT email FROM users WHERE username = 'prozor.dva'").get().email, 'Prozor.Dva@Primjer.ba');
  const after = await m.request('/mitglied');
  assert.ok(!hasEmailPopup(after.text));
  assert.doesNotMatch(after.text, /notice-link" href="\/mitglied\/moji-podaci"/);
  assert.match(after.text, /e-mail adresa je sačuvana/);
  // Nie wieder, auch bei weiteren Logins
  const m2 = client();
  await m2.login('prozor.dva', 'memberpass1');
  assert.ok(!hasEmailPopup((await m2.request('/mitglied')).text));
  // Ohne angemeldetes Fenster kann über diesen Weg nichts geändert werden
  const late = await m2.post('/mitglied/email-prozor', { email: 'andere@primjer.ba' }, '/mitglied');
  assert.equal(late.status, 302);
  assert.equal(db.prepare("SELECT email FROM users WHERE username = 'prozor.dva'").get().email, 'Prozor.Dva@Primjer.ba');
});

test('E-Mail-Fenster: nicht für Kinder-Konten und nicht für Mitglieder mit E-Mail', async () => {
  makeMember('Prozor Mail', 'prozor.mail');
  const m = client();
  await m.login('prozor.mail', 'memberpass1');
  assert.ok(!hasEmailPopup((await m.request('/mitglied')).text));
  // Kind ohne E-Mail (Platzhalter) – auch beim ersten Login kein Fenster
  await m.post('/mitglied/djeca', { name: 'Prozor Dijete', username: 'prozor.kid', password: 'kid-pass-123' }, '/mitglied/djeca');
  assert.match(db.prepare("SELECT email FROM users WHERE username = 'prozor.kid'").get().email, /bez-emaila/);
  const kid = client();
  await kid.login('prozor.kid', 'kid-pass-123');
  const kidHome = await kid.request('/mitglied');
  assert.ok(!hasEmailPopup(kidHome.text));
  assert.ok(!kidHome.text.includes(EMAIL_POPUP_TEXT));
  assert.equal((await kid.post('/mitglied/email-prozor', { email: 'kid@primjer.ba' }, '/mitglied')).status, 403);
});
