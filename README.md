# Jare Mainframe

A personal life operating system: budgeting, goals, projects, debts and repairs
in one place, built around Nigerian banking. Transactions are logged
automatically by reading bank alert emails.

Live at [jare-mainframe.pages.dev](https://jare-mainframe.pages.dev/).

## Stack

| | |
|---|---|
| Frontend | React 19, Vite 6, Tailwind 4, React Router 7 |
| Backend | Supabase (Postgres, Auth, Realtime) |
| Hosting | Cloudflare Pages — pushes to `main` deploy automatically |
| Sync | GitHub Actions cron, Gmail API, Ollama Cloud / NVIDIA NIM |

## Setup

```bash
npm install
cp .env.example .env.local   # fill in the VITE_ values
npm run dev
```

```bash
npm test        # unit tests
npm run build   # production build into dist/
```

Database schema changes live in `supabase/migrations/`. Run them in the
Supabase SQL Editor, in order.

## How transaction sync works

Bank alert emails are read from Gmail and turned into transactions. Which
addresses to search comes from the `wallets` table, not from code — adding a
bank is a Settings edit, not a deploy.

```
Gmail  ──▶  match sender to wallet  ──▶  parse  ──▶  validate  ──▶  upsert
                                          │
                             ┌────────────┴────────────┐
                             │                         │
                        rules parser              LLM (Ollama,
                     (src/lib/parsers/)          NVIDIA fallback)
```

Two entry points, one implementation:

- **Background** — `scripts/gmail-sync.mjs`, on cron at 8am, 10am, 2pm and 6pm
  Lagos, plus a manual trigger from the Actions tab. Uses a Google refresh
  token, so it keeps working unattended. This is the durable path.
- **Manual** — the "Sync now" button in Settings. Uses a browser OAuth token
  that expires after about an hour, and has no LLM, so it skips wallets that
  need one and reports how many it left behind.

Everything they share lives in `src/lib/sync/`.

### Parse strategy

Each wallet chooses how its alerts are read, in Settings → Banks & Wallets:

| Strategy | Behaviour |
|---|---|
| `rules` | Pattern matching only. For banks that clearly label DEBIT and CREDIT. |
| `auto` | Rules first, LLM if they come up empty. The default. |
| `llm` | Always the LLM. |

`llm` exists because some providers cannot be read by rules at all. Opay and
PiggyVest describe money in and money out with the same word — "transfer" — so
no keyword can tell the direction, and a wrong direction quietly corrupts the
monthly totals. Those wallets go to the LLM, which reasons about who sent and
who received.

### Deduplication

Every sync re-reads a window of email, so the same alert is seen many times.
Two guards keep the ledger clean:

1. A unique index on `(source, transaction_id)`. The database refuses the second
   write, which also closes the race between a cron run and a manual sync.
2. For alerts that carry no bank reference — GTBank charge and stamp-duty
   emails ship an empty Document Number — a synthetic ID is derived from the
   transaction's own content with FNV-1a. It must stay deterministic and
   identical in Node and the browser, or the same email is inserted forever.
   `tests/dedup.test.js` guards that.

## When something stops working

### Migrations and the deploy gap

Cloudflare deploys the frontend the moment a commit lands on `main`. Migrations
in `supabase/migrations/` are run by hand afterwards, so there is always a window
where the app expects a column the database does not have yet.

The app handles this rather than dying: `src/lib/schema.js` probes for
migration-added columns at startup, drops the missing ones from its queries, and
shows a banner naming the file to run. **If you see that banner, run the file it
names in the Supabase SQL editor.** It went in after a version of this gap took
every transaction page down for days.

To check what is missing without opening the app:

```sql
select
  exists (select 1 from information_schema.columns
           where table_name='transactions' and column_name='explanation') as has_005,
  exists (select 1 from information_schema.columns
           where table_name='goals' and column_name='slot')               as has_003;
```

Adding a migration-gated column to a shared select list means adding it to
`GATED_COLUMNS` in `src/lib/schema.js` in the same change. Forgetting is the bug.

### The scheduled sync stopped importing

A failed run now opens a **`sync-failure`** issue rather than failing silently.
The most common cause is `invalid_grant` — the Google refresh token expired or
was revoked. Regenerate it:

```bash
GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." node scripts/get-refresh-token.mjs
```

and paste the result into the `GOOGLE_REFRESH_TOKEN` repository secret.

If this recurs roughly weekly, the cause is the OAuth consent screen: Google
expires refresh tokens issued by an app in **Testing** publishing status after 7
days. Set the app to **In production** in the Google Cloud console and they stop
expiring.

## Environment

See `.env.example`. In short: `VITE_`-prefixed variables are compiled into the
browser bundle and are public by design; everything else belongs in GitHub
Actions secrets and is never bundled.

Model IDs and endpoints are configurable so a renamed model needs a secret
change rather than a code change. Verify them with:

```bash
OLLAMA_API_KEY=... NVIDIA_API_KEY=... node scripts/test-llm.mjs
```

## Tests

```
tests/
  dedup.test.js       synthetic ID determinism, FNV-1a vectors
  parsers.test.js     GTBank and Opay against email fixtures
  normalize.test.js   validation, LLM JSON extraction
  gmailQuery.test.js  query building, pagination, body extraction
  wallets.test.js     sender routing, parse strategy
```

Parsing correctness is the whole value of this project, so the highest-value
contribution is a real bank email — **redacted** — added to
`tests/fixtures/emails/`. Zenith, Polaris and PiggyVest have none yet. See the
README in that directory.
