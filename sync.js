#!/usr/bin/env node
/*
 * JLFinance sync — Milestone 1
 * Wells Fargo checking only. Reads transactions from Plaid and writes files
 * you paste/import into JLFinance. Nothing here talks to your app directly.
 *
 * Commands:
 *   node sync.js connect   — one time (and again only if the link breaks)
 *   node sync.js pull      — every time you want fresh transactions
 *   node sync.js status    — what is currently connected
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const DIR = __dirname;
const STATE_FILE = path.join(DIR, 'state.json');
const OUT_DIR = path.join(DIR, 'out');

// ---------------------------------------------------------------- plaid client

function client() {
  const id = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = (process.env.PLAID_ENV || 'production').toLowerCase();
  if (!id || !secret) {
    die('PLAID_CLIENT_ID and PLAID_SECRET are missing.\n' +
        'Copy .env.example to .env and paste your keys from the Plaid dashboard.');
  }
  if (!PlaidEnvironments[env]) die(`PLAID_ENV must be production or sandbox (got "${env}").`);
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': id, 'PLAID-SECRET': secret } },
  }));
}

// ---------------------------------------------------------------- small helpers

function die(msg) { console.error('\n' + msg + '\n'); process.exit(1); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function money(n) { return (n < 0 ? '-' : '') + Math.abs(n).toFixed(2); }
function plaidErr(e) {
  const d = e && e.response && e.response.data;
  return d ? `${d.error_code}: ${d.error_message}` : (e && e.message) || String(e);
}

// ---------------------------------------------------------------- connect

async function connect() {
  const c = client();
  const existing = loadState();
  if (existing && existing.access_token) {
    const a = await ask('An account is already connected. Reconnecting uses another of your 10 free slots.\nType "yes" to continue: ');
    if (a.toLowerCase() !== 'yes') { console.log('Cancelled. Nothing changed.'); return; }
  }

  // days_requested is fixed for the life of this connection. It cannot be raised
  // later without deleting and recreating the Item, which burns another slot.
  const days = parseInt(process.env.DAYS_REQUESTED || '730', 10);
  if (!(days >= 1 && days <= 730)) die('DAYS_REQUESTED must be between 1 and 730.');

  console.log(`\nRequesting ${days} days of history (this is permanent for this connection).`);

  let create;
  try {
    create = await c.linkTokenCreate({
      user: { client_user_id: 'jlfinance-local' },
      client_name: 'JLFinance',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      transactions: { days_requested: days },
      hosted_link: { url_lifetime_seconds: 1800 },
    });
  } catch (e) { die('Could not start the connection.\n' + plaidErr(e)); }

  const linkToken = create.data.link_token;
  const url = create.data.hosted_link_url;
  if (!url) die('Plaid did not return a hosted link URL. Hosted Link may not be enabled for this team.');

  console.log('\n─────────────────────────────────────────────');
  console.log('Open this link in your browser and sign in to');
  console.log('Wells Fargo. It expires in 30 minutes.\n');
  console.log('  ' + url);
  console.log('─────────────────────────────────────────────\n');
  console.log('Waiting for you to finish... (Ctrl+C to cancel)');

  // Poll until the hosted flow reports success. No callback is possible here —
  // Plaid documents polling /link/token/get as the way to collect the token.
  const deadline = Date.now() + 30 * 60 * 1000;
  let publicToken = null;
  while (Date.now() < deadline) {
    await sleep(3000);
    let g;
    try { g = await c.linkTokenGet({ link_token: linkToken }); }
    catch (e) { continue; }
    const sessions = (g.data && g.data.link_sessions) || [];
    for (const s of sessions) {
      if (s.results && s.results.item_add_results && s.results.item_add_results.length) {
        publicToken = s.results.item_add_results[0].public_token;
      } else if (s.on_success && s.on_success.public_token) {
        publicToken = s.on_success.public_token;
      }
      if (publicToken) break;
    }
    if (publicToken) break;
    process.stdout.write('.');
  }
  console.log('');
  if (!publicToken) die('Timed out waiting for the connection. Run "node sync.js connect" again.');

  let exch;
  try { exch = await c.itemPublicTokenExchange({ public_token: publicToken }); }
  catch (e) { die('Could not finish the connection.\n' + plaidErr(e)); }

  const accessToken = exch.data.access_token;

  let accts;
  try { accts = await c.accountsGet({ access_token: accessToken }); }
  catch (e) { die('Connected, but could not list accounts.\n' + plaidErr(e)); }

  const list = accts.data.accounts;
  console.log('\nAccounts on this connection:\n');
  list.forEach((a, i) => {
    console.log(`  ${i + 1}. ${a.name}${a.mask ? ' ····' + a.mask : ''}  (${a.subtype || a.type})`);
  });

  let pick = list.findIndex(a => a.subtype === 'checking');
  if (list.length > 1) {
    const def = pick >= 0 ? pick + 1 : 1;
    const ans = await ask(`\nWhich one is your Wells Fargo checking? [${def}] `);
    const n = ans ? parseInt(ans, 10) : def;
    if (!(n >= 1 && n <= list.length)) die('That was not one of the numbers listed. Nothing was saved.');
    pick = n - 1;
  } else {
    pick = 0;
  }

  const chosen = list[pick];
  saveState({
    access_token: accessToken,
    item_id: exch.data.item_id,
    cursor: null,
    days_requested: days,
    connected_at: new Date().toISOString(),
    accountMap: { [chosen.account_id]: 'checking' },
    accountLabel: `${chosen.name}${chosen.mask ? ' ····' + chosen.mask : ''}`,
    txns: {},
  });

  console.log(`\nConnected: ${chosen.name}${chosen.mask ? ' ····' + chosen.mask : ''}`);
  console.log('Saved to state.json (stays on this Mac — never commit it).');
  console.log('\nNext: node sync.js pull\n');
}

// ---------------------------------------------------------------- mapping

// Plaid's convention: positive amount = money LEAVING the account.
const TRANSFER_CATS = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS']);

function mapTxn(pt, acct) {
  const out = pt.amount > 0;                 // money leaving
  const amt = Math.abs(pt.amount);
  const desc = String(pt.merchant_name || pt.name || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const pfc = (pt.personal_finance_category && pt.personal_finance_category.primary) || '';
  const isTransfer = TRANSFER_CATS.has(pfc);

  return {
    plaidId: pt.transaction_id,
    plaidAcct: pt.account_id,
    date: pt.date,
    authorizedDate: pt.authorized_date || null,
    desc,
    amt,
    acct,
    type: isTransfer ? 'Transfer' : (out ? 'Expense' : 'Income'),
    flow: isTransfer ? (out ? 'out' : 'in') : null,
    pfc,
    source: 'plaid',
  };
}

// ---------------------------------------------------------------- parser port
// A faithful port of the checking branch of parseLine() in index.html, so the
// report can say what JLFinance WILL do with a pasted line — not what we hope.

function appWouldInfer(line) {
  const clean = line.replace(/^(PURCHASE|DEBIT CARD PURCHASE|DEBIT|CREDIT CARD|RECURRING)\s+/i, '');
  const dm = clean.match(/^(\d{4}-\d{2}-\d{2})/);
  const am = clean.match(/[\-\+]?\$?([\d,]+\.\d{2})\s*$/);
  if (!dm || !am) return { parses: false };
  const desc = clean.replace(dm[0], '').replace(am[0], '').trim().replace(/\s+/g, ' ');
  if (!desc) return { parses: false };
  const up = (line + ' ' + desc).toUpperCase();
  const signed = am[0].trim();

  let isIncome = up.includes('PAYROLL') || up.includes('ZELLE FROM') || up.includes('DIRECT DEP')
    || up.includes('DIRECT DEPOSIT') || up.includes('MOBILE DEPOSIT') || up.includes('SCHOLARSHIP')
    || up.includes('INTEREST PAYMENT') || up.includes('REFUND') || up.includes('REVERSAL')
    || (up.includes('RETURN') && !up.includes('NO RETURN'))
    || (/\bCREDIT\b/.test(up) && !up.includes('CREDIT CARD'));
  if (signed.startsWith('-')) isIncome = false;

  const looksTransfer = up.includes('ONLINE TRANSFER') || up.includes('TRANSFER TO')
    || up.includes('TRANSFER FROM') || up.includes('AUTOPAY') || up.includes('CARD PAYMENT')
    || up.includes('EPAY');

  let xferFlow = null;
  if (looksTransfer) {
    if (/TRANSFER FROM|DEPOSIT FROM|PAYMENT (THANK YOU|RECEIVED)|PYMT THANK/.test(up)) xferFlow = 'in';
    else if (/TRANSFER TO|PAYMENT TO|AUTOPAY|CARD PAYMENT|EPAY/.test(up)) xferFlow = 'out';
    else xferFlow = signed.startsWith('-') ? 'out' : (isIncome ? 'in' : 'out');
  }

  return {
    parses: true,
    type: looksTransfer ? 'Transfer' : (isIncome ? 'Income' : 'Expense'),
    flow: xferFlow,
  };
}

function pasteLine(t) { return `${t.date} ${t.desc} ${money(t.amt)}`; }

// ---------------------------------------------------------------- pull

async function pull() {
  const state = loadState();
  if (!state || !state.access_token) die('Nothing is connected yet. Run: node sync.js connect');
  const c = client();
  state.txns = state.txns || {};

  let cursor = state.cursor || undefined;
  let added = 0, modified = 0, removed = 0, pendingSkipped = 0, otherAcct = 0;
  let hasMore = true;
  let pages = 0;

  console.log('Fetching...');
  while (hasMore) {
    let r;
    try { r = await c.transactionsSync({ access_token: state.access_token, cursor }); }
    catch (e) { die('Could not fetch transactions.\n' + plaidErr(e)); }
    const d = r.data;
    pages++;

    for (const pt of d.added) {
      const acct = state.accountMap[pt.account_id];
      if (!acct) { otherAcct++; continue; }
      // A posted row supersedes the pending row it came from, even if the
      // matching "removed" entry lands on a different page.
      if (pt.pending_transaction_id) delete state.txns[pt.pending_transaction_id];
      if (pt.pending) { pendingSkipped++; continue; }
      state.txns[pt.transaction_id] = mapTxn(pt, acct);
      added++;
    }
    for (const pt of d.modified) {
      const acct = state.accountMap[pt.account_id];
      if (!acct) { otherAcct++; continue; }
      if (pt.pending) { delete state.txns[pt.transaction_id]; pendingSkipped++; continue; }
      state.txns[pt.transaction_id] = mapTxn(pt, acct);
      modified++;
    }
    for (const rm of d.removed) {
      if (state.txns[rm.transaction_id]) { delete state.txns[rm.transaction_id]; removed++; }
    }

    cursor = d.next_cursor;
    hasMore = d.has_more;
  }

  state.cursor = cursor;
  state.last_pull = new Date().toISOString();
  saveState(state);

  const all = Object.values(state.txns).sort((a, b) => a.date.localeCompare(b.date));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'plaid-export.json'), JSON.stringify(all, null, 2));

  const lines = all.map(pasteLine);
  fs.writeFileSync(path.join(OUT_DIR, 'paste.txt'), lines.join('\n') + '\n');

  // ---- the dry-run report: where JLFinance's parser and Plaid disagree ----
  const mismatches = [];
  const unparseable = [];
  all.forEach(t => {
    const guess = appWouldInfer(pasteLine(t));
    if (!guess.parses) { unparseable.push(t); return; }
    if (guess.type !== t.type || (guess.flow || null) !== (t.flow || null)) {
      mismatches.push({ t, guess });
    }
  });

  const rep = [];
  rep.push('JLFinance sync — dry run report');
  rep.push(`Generated ${new Date().toISOString()}`);
  rep.push(`Account: ${state.accountLabel}`);
  rep.push('');
  rep.push(`This pull:  ${added} added, ${modified} modified, ${removed} removed`);
  rep.push(`Skipped:    ${pendingSkipped} still pending, ${otherAcct} on other accounts`);
  rep.push(`Stored:     ${all.length} posted transactions`);
  if (all.length) rep.push(`Range:      ${all[0].date} to ${all[all.length - 1].date}`);
  rep.push('');
  rep.push('--- Where pasting would get it WRONG -------------------------------');
  rep.push('');
  if (!unparseable.length && !mismatches.length) {
    rep.push('None. Every row in paste.txt would be read correctly by the app.');
  }
  if (unparseable.length) {
    rep.push(`${unparseable.length} row(s) the app\'s parser would not recognize at all:`);
    unparseable.forEach(t => rep.push(`  ${pasteLine(t)}`));
    rep.push('');
  }
  if (mismatches.length) {
    rep.push(`${mismatches.length} row(s) the app would file differently than Plaid says:`);
    rep.push('');
    mismatches.forEach(({ t, guess }) => {
      const truth = t.type + (t.flow ? ' ' + t.flow : '');
      const got = guess.type + (guess.flow ? ' ' + guess.flow : '');
      rep.push(`  ${pasteLine(t)}`);
      rep.push(`      Plaid says: ${truth}   |   app would read: ${got}`);
    });
    rep.push('');
    rep.push('These are the rows to fix by hand after importing, or the reason to');
    rep.push('build a real import path in milestone 2. plaid-export.json has the');
    rep.push('correct values for all of them.');
  }
  rep.push('');

  const report = rep.join('\n');
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), report + '\n');

  console.log('');
  console.log(report);
  console.log('Files written to: ' + OUT_DIR);
  console.log('  paste.txt          → paste into JLFinance\'s import box');
  console.log('  report.txt         → read this before you trust the paste');
  console.log('  plaid-export.json  → full data, correct in every field');
  console.log('');
}

// ---------------------------------------------------------------- status

function status() {
  const s = loadState();
  if (!s || !s.access_token) { console.log('\nNothing connected. Run: node sync.js connect\n'); return; }
  const n = Object.keys(s.txns || {}).length;
  console.log('');
  console.log(`Connected:      ${s.accountLabel}`);
  console.log(`Connected on:   ${s.connected_at}`);
  console.log(`History window: ${s.days_requested} days (fixed for this connection)`);
  console.log(`Last pull:      ${s.last_pull || 'never'}`);
  console.log(`Stored rows:    ${n}`);
  console.log('');
}

// ---------------------------------------------------------------- main

module.exports = { mapTxn, appWouldInfer, pasteLine };

if (require.main !== module) return;

const cmd = process.argv[2];
(async () => {
  if (cmd === 'connect') await connect();
  else if (cmd === 'pull') await pull();
  else if (cmd === 'status') status();
  else {
    console.log('\nUsage:');
    console.log('  node sync.js connect   one time, opens a link to sign in to your bank');
    console.log('  node sync.js pull      get fresh transactions');
    console.log('  node sync.js status    what is connected\n');
  }
})().catch(e => die('Unexpected error:\n' + (e.stack || e.message || String(e))));
