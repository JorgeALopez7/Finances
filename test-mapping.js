// Offline check of the mapping and the parser port. No network, no Plaid keys.
const { mapTxn, appWouldInfer, pasteLine } = require('./sync.js');

const cases = [
  { label: 'card purchase (money out)',
    pt: { transaction_id: 't1', account_id: 'a', date: '2026-08-03', amount: 42.15,
          merchant_name: 'Chipotle', personal_finance_category: { primary: 'FOOD_AND_DRINK' } },
    expect: { type: 'Expense', flow: null } },

  { label: 'payroll deposit (money in)',
    pt: { transaction_id: 't2', account_id: 'a', date: '2026-08-01', amount: -1840.22,
          name: 'PAYROLL DIRECT DEP', personal_finance_category: { primary: 'INCOME' } },
    expect: { type: 'Income', flow: null } },

  { label: 'transfer to savings (money out)',
    pt: { transaction_id: 't3', account_id: 'a', date: '2026-08-05', amount: 200,
          name: 'ONLINE TRANSFER TO WAY2SAVE', personal_finance_category: { primary: 'TRANSFER_OUT' } },
    expect: { type: 'Transfer', flow: 'out' } },

  { label: 'card autopay (loan payment, money out)',
    pt: { transaction_id: 't4', account_id: 'a', date: '2026-08-06', amount: 120.5,
          name: 'CAPITAL ONE AUTOPAY', personal_finance_category: { primary: 'LOAN_PAYMENTS' } },
    expect: { type: 'Transfer', flow: 'out' } },

  { label: 'transfer in from savings (money in)',
    pt: { transaction_id: 't5', account_id: 'a', date: '2026-08-07', amount: -50,
          name: 'ONLINE TRANSFER FROM WAY2SAVE', personal_finance_category: { primary: 'TRANSFER_IN' } },
    expect: { type: 'Transfer', flow: 'in' } },

  { label: 'refund (money in, keyword present)',
    pt: { transaction_id: 't6', account_id: 'a', date: '2026-08-08', amount: -19.99,
          merchant_name: 'Amazon Refund', personal_finance_category: { primary: 'GENERAL_MERCHANDISE' } },
    expect: { type: 'Income', flow: null } },

  { label: 'venmo credit, NO keyword (the hard case)',
    pt: { transaction_id: 't7', account_id: 'a', date: '2026-08-09', amount: -35,
          merchant_name: 'Venmo', personal_finance_category: { primary: 'GENERAL_MERCHANDISE' } },
    expect: { type: 'Income', flow: null } },
];

let fail = 0;
console.log('\n== mapping: Plaid -> JLFinance shape ==\n');
for (const c of cases) {
  const m = mapTxn(c.pt, 'checking');
  const ok = m.type === c.expect.type && (m.flow || null) === (c.expect.flow || null);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${c.label}`);
  if (!ok) console.log(`        got ${m.type}/${m.flow}  want ${c.expect.type}/${c.expect.flow}`);
}

console.log('\n== parser port: what the app would do with the pasted line ==\n');
let disagree = 0;
for (const c of cases) {
  const m = mapTxn(c.pt, 'checking');
  const line = pasteLine(m);
  const g = appWouldInfer(line);
  const same = g.parses && g.type === m.type && (g.flow || null) === (m.flow || null);
  if (!same) disagree++;
  console.log(`${same ? 'agree   ' : 'DISAGREE'}  ${line}`);
  if (!same) console.log(`            plaid=${m.type}/${m.flow}  app=${g.parses ? g.type + '/' + g.flow : 'unparseable'}`);
}

console.log(`\n${fail} mapping failures, ${disagree} paste disagreements (disagreements are expected and get reported).\n`);
process.exit(fail ? 1 : 0);
