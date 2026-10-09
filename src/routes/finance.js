'use strict';

const express = require('express');
const { html } = require('../html');
const D = require('../dates');
const { formatMoney, parseMoney, CURRENCY_SYMBOL } = require('../money');
const { monthlyStatement } = require('../billing');
const { trainerReport } = require('../trainers');
const { layout, csrfField, monthNav } = require('../views');
const { requireAdmin } = require('../auth');
const { str } = require('./public');

// Finansije škole po mjesecu: prihodi i rashodi te rezultat (dobit / gubitak).
// Automatski se uzimaju: uplate članova (obračuni označeni kao „plaćeno“) i isplate trenerima.
// Sve ostalo admin unosi ručno po kategorijama.
const INCOME_CATEGORIES = [
  'Profit od turnira',
  'Kampovi i radionice',
  'Sponzorstva i donacije',
  'Najam terena drugima',
  'Prodaja opreme',
  'Ostali prihodi',
];
const EXPENSE_CATEGORIES = [
  'Najam terena',
  'Loptice',
  'Struja',
  'Voda',
  'Rekviziti',
  'Gorivo',
  'Održavanje terena',
  'Osiguranje',
  'Marketing i reklama',
  'Članarine i takse (savez)',
  'Knjigovodstvo',
  'Ostale investicije',
  'Ostali troškovi',
];

function toId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Kompletna finansijska kalkulacija za jedan mjesec.
function financeMonth(db, month) {
  const members = db.prepare("SELECT * FROM users WHERE role = 'member'").all();
  let memberPaid = 0;
  let memberExpected = 0;
  let paidCount = 0;
  for (const m of members) {
    const st = monthlyStatement(db, m, month);
    memberExpected += st.total;
    if (st.paid) {
      memberPaid += st.total;
      paidCount += 1;
    }
  }
  const trainers = db.prepare('SELECT * FROM trainers').all();
  const trainerPay = trainers.reduce((sum, t) => sum + trainerReport(db, t, month).payTotal, 0);

  const entries = db.prepare('SELECT * FROM finance_entries WHERE month = ? ORDER BY type, category, id').all(month);
  const incomeEntries = entries.filter((e) => e.type === 'income');
  const expenseEntries = entries.filter((e) => e.type === 'expense');
  const sum = (list) => list.reduce((s, e) => s + e.amount_cents, 0);

  const income = memberPaid + sum(incomeEntries);
  const expense = trainerPay + sum(expenseEntries);
  return {
    month,
    memberPaid,
    memberExpected,
    memberOpen: memberExpected - memberPaid,
    paidCount,
    trainerPay,
    incomeEntries,
    expenseEntries,
    income,
    expense,
    result: income - expense,
  };
}

// Zbir po kategoriji (za pregled).
function byCategory(list, categories) {
  const totals = new Map(categories.map((c) => [c, 0]));
  for (const e of list) totals.set(e.category, (totals.get(e.category) || 0) + e.amount_cents);
  return [...totals.entries()].filter(([, v]) => v !== 0);
}

function resultClass(cents) {
  if (cents > 0) return 'positive';
  if (cents < 0) return 'negative';
  return '';
}

function financeRoutes(db) {
  const router = express.Router();
  router.use(requireAdmin);

  router.get('/', (req, res) => {
    const month = D.isValidMonth(req.query.monat) ? req.query.monat : D.monthOf(D.todayISO());
    const f = financeMonth(db, month);
    const year = month.slice(0, 4);
    const yearRows = Array.from({ length: 12 }, (_, i) => financeMonth(db, `${year}-${String(i + 1).padStart(2, '0')}`));
    const yearIncome = yearRows.reduce((s, r) => s + r.income, 0);
    const yearExpense = yearRows.reduce((s, r) => s + r.expense, 0);

    const entryRow = (e) => html`
      <tr>
        <td>${e.category}</td>
        <td>${e.description || ''}</td>
        <td class="num">${formatMoney(e.amount_cents)}</td>
        <td class="num">
          <form method="post" action="/admin/finansije/${e.id}/loeschen" class="inline-form" data-confirm="Obrisati stavku „${e.category}“?">
            ${csrfField(req)}<button class="btn btn-danger btn-sm" type="submit">Obriši</button>
          </form>
        </td>
      </tr>`;

    const addForm = (type, categories) => html`
      <form method="post" action="/admin/finansije" class="form-grid finance-form">
        ${csrfField(req)}
        <input type="hidden" name="month" value="${month}">
        <input type="hidden" name="type" value="${type}">
        <label>Kategorija *
          <select name="category">${categories.map((c) => html`<option>${c}</option>`)}</select>
        </label>
        <label>Iznos (${CURRENCY_SYMBOL}) *<input name="amount" required inputmode="decimal" placeholder="npr. 250,00"></label>
        <label class="span-2">Opis<input name="description" maxlength="200" placeholder="${type === 'income' ? 'npr. Jesenji klupski turnir' : 'npr. račun za oktobar'}"></label>
        <div class="span-2"><button class="btn btn-primary btn-sm" type="submit">${type === 'income' ? 'Dodaj prihod' : 'Dodaj rashod'}</button></div>
      </form>`;

    res.send(String(layout(req, {
      title: 'Finansije',
      wide: true,
      body: html`
      <div class="page-head"><div>
        <h1>Prihodi i rashodi</h1>
        <p class="muted">Finansijska kalkulacija škole po mjesecu. Uplate članova i isplate trenerima računaju se automatski, ostale stavke unosiš ručno.</p>
      </div></div>
      ${monthNav('/admin/finansije', month)}

      <div class="tiles">
        <div class="summary-tile"><span class="label">Prihodi ${D.monthLabel(month)}</span><span class="value positive">${formatMoney(f.income)}</span>
          <span class="hint">od toga uplate članova ${formatMoney(f.memberPaid)}</span></div>
        <div class="summary-tile"><span class="label">Rashodi ${D.monthLabel(month)}</span><span class="value negative">${formatMoney(f.expense)}</span>
          <span class="hint">od toga treneri ${formatMoney(f.trainerPay)}</span></div>
        <div class="summary-tile big"><span class="label">Rezultat (${f.result >= 0 ? 'dobit' : 'gubitak'})</span>
          <span class="value ${resultClass(f.result)}">${formatMoney(f.result)}</span>
          <span class="hint">prihodi − rashodi</span></div>
      </div>

      <div class="two-col">
        <section class="card">
          <h2>Prihodi</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Kategorija</th><th>Opis</th><th class="num">Iznos</th><th></th></tr></thead>
            <tbody>
              <tr class="auto-row"><td>Uplate članova <span class="tag">automatski</span></td>
                <td>Plaćeni obračuni: ${f.paidCount} · još otvoreno ${formatMoney(f.memberOpen)} · <a href="/admin/abrechnung?monat=${month}">Iznosi</a></td>
                <td class="num">${formatMoney(f.memberPaid)}</td><td></td></tr>
              ${f.incomeEntries.map(entryRow)}
            </tbody>
            <tfoot><tr class="total"><td colspan="2">Ukupno prihodi</td><td class="num">${formatMoney(f.income)}</td><td></td></tr></tfoot>
          </table></div>
          <h3>Dodaj prihod</h3>
          ${addForm('income', INCOME_CATEGORIES)}
        </section>

        <section class="card">
          <h2>Rashodi</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Kategorija</th><th>Opis</th><th class="num">Iznos</th><th></th></tr></thead>
            <tbody>
              <tr class="auto-row"><td>Isplate trenerima <span class="tag">automatski</span></td>
                <td>Iz izvještaja trenera (uklj. dodatne isplate) · <a href="/admin/treneri?monat=${month}">Treneri</a></td>
                <td class="num">${formatMoney(f.trainerPay)}</td><td></td></tr>
              ${f.expenseEntries.map(entryRow)}
            </tbody>
            <tfoot><tr class="total"><td colspan="2">Ukupno rashodi</td><td class="num">${formatMoney(f.expense)}</td><td></td></tr></tfoot>
          </table></div>
          <h3>Dodaj rashod</h3>
          ${addForm('expense', EXPENSE_CATEGORIES)}
        </section>
      </div>

      ${f.expenseEntries.length
        ? html`<section class="card">
            <h2>Rashodi po kategorijama</h2>
            <ul class="list">${[['Isplate trenerima', f.trainerPay], ...byCategory(f.expenseEntries, EXPENSE_CATEGORIES)]
              .filter(([, v]) => v)
              .sort((a, b) => b[1] - a[1])
              .map(([c, v]) => html`<li class="news-row"><span>${c}</span><span><strong>${formatMoney(v)}</strong>
                <span class="muted small">(${f.expense ? Math.round((v / f.expense) * 100) : 0} %)</span></span></li>`)}</ul>
          </section>`
        : ''}

      <section class="card">
        <h2>Pregled godine ${year}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Mjesec</th><th class="num">Prihodi</th><th class="num">Rashodi</th><th class="num">Rezultat</th></tr></thead>
          <tbody>${yearRows.map((r) => html`
            <tr${r.month === month ? html` class="is-selected"` : ''}>
              <td><a href="/admin/finansije?monat=${r.month}">${D.monthLabel(r.month)}</a></td>
              <td class="num">${formatMoney(r.income)}</td>
              <td class="num">${formatMoney(r.expense)}</td>
              <td class="num ${resultClass(r.result)}"><strong>${formatMoney(r.result)}</strong></td>
            </tr>`)}</tbody>
          <tfoot><tr class="total"><td>Ukupno ${year}</td><td class="num">${formatMoney(yearIncome)}</td><td class="num">${formatMoney(yearExpense)}</td>
            <td class="num ${resultClass(yearIncome - yearExpense)}">${formatMoney(yearIncome - yearExpense)}</td></tr></tfoot>
        </table></div>
        <p class="muted small">Uplate članova računaju se samo za obračune označene kao „plaćeno“. Isplate trenerima prema realizovanim terminima i satnici trenera.</p>
      </section>`,
    })));
  });

  router.post('/', (req, res) => {
    const month = D.isValidMonth(req.body.month) ? req.body.month : D.monthOf(D.todayISO());
    const type = req.body.type === 'income' ? 'income' : 'expense';
    const categories = type === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    const category = categories.includes(req.body.category) ? req.body.category : null;
    const amount = parseMoney(req.body.amount);
    if (!category || amount === null || amount <= 0) {
      res.flash('error', 'Odaberi kategoriju i unesi ispravan iznos veći od 0.');
    } else {
      db.prepare('INSERT INTO finance_entries (month, type, category, description, amount_cents) VALUES (?, ?, ?, ?, ?)')
        .run(month, type, category, str(req.body.description, 200) || null, amount);
      res.flash('success', `${type === 'income' ? 'Prihod' : 'Rashod'} „${category}“ (${formatMoney(amount)}) je dodan.`);
    }
    res.redirect(`/admin/finansije?monat=${month}`);
  });

  router.post('/:id/loeschen', (req, res) => {
    const entry = db.prepare('SELECT * FROM finance_entries WHERE id = ?').get(toId(req.params.id));
    if (!entry) return res.status(404).send('Nije pronađeno: stavka.');
    db.prepare('DELETE FROM finance_entries WHERE id = ?').run(entry.id);
    res.flash('success', 'Stavka je obrisana.');
    res.redirect(`/admin/finansije?monat=${entry.month}`);
  });

  return router;
}

module.exports = financeRoutes;
module.exports.financeMonth = financeMonth;
module.exports.INCOME_CATEGORIES = INCOME_CATEGORIES;
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
