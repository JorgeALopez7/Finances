# JLFinance sync

Pulls your Wells Fargo checking transactions from Plaid and writes them to files
you paste into JLFinance. Everything runs on your Mac. Your Plaid keys and your
bank connection never leave this folder.

**Your app is not modified.** This does not touch `index.html`, and it does not
talk to your app directly. You paste, same as today — the difference is you no
longer copy from the bank's website by hand.

---

## Setup (once, about five minutes)

**1. Check you have Node.** Open Terminal and run:

```
node --version
```

If that prints a version number (v18 or higher), you're set. If it says "command
not found", install Node from https://nodejs.org — take the big green LTS button.

**2. Put this folder somewhere you'll find it**, e.g. `~/Documents/jlfinance-sync`.

**3. In Terminal, go into the folder and install:**

```
cd ~/Documents/jlfinance-sync
npm install
```

**4. Add your Plaid keys.** In the Plaid dashboard go to **Developers → Keys** and
copy your client ID and your **Production** secret. Then:

```
cp .env.example .env
open -e .env
```

Paste the two values in, save, close.

---

## Connecting your bank (once)

```
node sync.js connect
```

It prints a link. Open it in your browser, sign in to Wells Fargo, and come back —
the script is waiting and will finish on its own. It then asks which account is
your checking; press Enter to take the suggestion.

**Before you run this, know one thing:** the amount of history you get is decided
at this moment and can never be increased later without reconnecting, and every
reconnect permanently uses one of your 10 free connection slots. The default asks
for the full 2 years, which is what you want. Don't run `connect` casually.

You only do this again if the connection breaks — a password change, or Wells
Fargo asking you to re-authorize. A few times a year at most.

---

## Getting transactions (whenever you want)

```
node sync.js pull
```

This writes three files into an `out` folder:

| File | What it's for |
|---|---|
| `report.txt` | **Read this first.** Tells you what it found and, more importantly, which rows JLFinance would misread if you pasted them. |
| `paste.txt` | Paste this into JLFinance's import box. Your existing duplicate check runs on it exactly as it does today. |
| `plaid-export.json` | The full, correct data. Not needed yet — it's there for the next milestone. |

Each pull only fetches what's changed since last time, so it's fast after the first
one. Pending transactions are skipped on purpose; they show up once they post.

To see what's connected:

```
node sync.js status
```

---

## About `report.txt`

This is the part that matters right now.

JLFinance figures out whether a line is income, an expense, or a transfer by
looking for words in the description — "PAYROLL", "TRANSFER TO", and so on. Plaid
tells us the answer outright. Those two usually agree, but not always.

When a deposit arrives with a description that has none of the words the app looks
for, the app will read it as an expense. `report.txt` lists every row where that
happens, so you can fix those few by hand instead of finding a wrong balance later.

If that list is consistently empty, pasting is all you'll ever need. If it's long,
that's the evidence for building a proper import path next.

---

## Checking it still works

```
npm test
```

Runs offline against sample data. No keys or network needed. Confirms the Plaid →
JLFinance mapping is right and shows the kind of row that gets flagged in the
report.

---

## Files that must never be shared or committed

- `.env` — your Plaid keys
- `state.json` — your bank access token and transaction history
- `out/` — your actual transactions

`.gitignore` already excludes all of these. Don't put this folder inside your
public `Finances` repo.
