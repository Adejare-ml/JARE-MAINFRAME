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

### Install it on your phone

The app is installable: `public/manifest.webmanifest` names it and its
icons, and `public/sw.js` caches the shell so it opens offline (pages then
show their own error state with a Retry; nothing is written offline).
Android and desktop Chrome offer "Install" from the address bar; on iOS use
Share → Add to Home Screen. The service worker only registers in production
builds, so `npm run dev` is unaffected. Lighthouse's "Installable" audit is
the check that everything is wired.

### Reminders on your phone

One notification each morning at 07:30 with what needs you (debts due,
bills expected, urgent repairs, milestones past their date, rows waiting
for review); nothing on a quiet day. Four steps, once:

1. `node scripts/generate-vapid.mjs` prints a key pair.
2. Put the public key in the Cloudflare Pages build variable
   `VITE_VAPID_PUBLIC_KEY` and the Actions secret `VAPID_PUBLIC_KEY`; put
   the private key in the Actions secret `VAPID_PRIVATE_KEY` only.
3. Redeploy, then on each phone open Settings → Reminders and tap **Turn on
   for this device** (iPhone: install to the Home Screen first, then open
   the app from there).
4. Run the **Morning Reminder** workflow by hand with `dry_run` set to
   `false` and watch for the notification. The log names every device and
   what the push service said.

A device the push service reports gone is removed automatically; any other
failure is retried the next morning and shown as "Last send failed" in
Settings.

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

### Since 23 Sep 2026: the mailbox is read by a Claude scheduled task

The token-based sync above is retired from the schedule (the workflow
still runs by hand for a backfill). Its Google refresh token expired every
seven days while the OAuth app sat in "Testing" status, and it had been
failing on `invalid_grant` since mid-August.

The owner's Claude scheduled task ("Daily spending audit", 08:00 UTC)
already reads the same GTBank, OPay and Stanbic alerts through Claude's own
Gmail connection, with nothing to keep alive. It now also writes each
alert into the ledger through one function, `ingest_alert_transaction`
(`supabase/migrations/032_alert_ingest.sql`), and records its run with
`record_sync_run`. Everything the sync used to enforce lives in that
function: the owner is resolved, the wallet must exist by slug, the id is
the Gmail message id so a re-run inserts nothing, an alert the old sync
already imported is refused by its natural key, and a wallet balance never
moves backwards. Low-confidence rows land in the review queue exactly as
before. Settings → System shows the task as "Bank alerts (Claude audit)".

The task needs a Supabase connector in Claude that can write. The
standard one cannot: its `execute_sql` runs as `supabase_read_only_user`
inside a read-only transaction and answers `permission denied for
function` (every run from 23 to 26 Sep hit exactly this; no grant can
change it). The one that works is a second, custom connector on
`https://mcp.supabase.com/mcp?project_ref=<project ref>&features=database`
(no `read_only`), whose `execute_sql` runs as `postgres`. The task's
prompt names that connector, and since 26 Sep its runs record alerts
through it. The functions are granted to `postgres` and `service_role`
only, so the browser's anon key still cannot call them.
`033_claude_audit_channel.sql` was written for a fallback through
`apply_migration` and is harmless on this path: it only clears
`claude_audit_%` rows from the migrations ledger, which never appear.

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

### Every scheduled job fails on its first line

`❌ Missing required environment variables: OWNER_USER_ID` means the scripts
could not work out whose rows to write. They read the `OWNER_USER_ID`
repository secret and, when it is blank, fall back to the single account in
`auth.users`. That fallback refuses to guess between two accounts -- set the
secret (`select id, email from auth.users;`) and the jobs resume.

Two Supabase projects with the same name are the other way this goes wrong:
the app, the Actions secrets and the SQL editor must all point at the same
project ref. The Migrations page only lists migrations applied through the
CLI or MCP; anything pasted into the SQL editor never appears there even when
it worked, so check the banner in the app, not that page.

### The app shows an old build after a deploy

`public/sw.js` serves navigations network-first, so a normal load picks up
the new build; hashed assets under `/assets/` are cache-first because their
names change with every build. If something still looks stale, reload once
more (the worker updates in the background and takes over on the next
load), or in DevTools → Application → Service Workers → Unregister. Bump
`VERSION` in `public/sw.js` to purge every cache on the next activate.

### Forgot your password?

"Forgot password?" on the sign-in page emails a reset link. The link opens
`/reset-password` on this app, signs you in with a one-time recovery
session, and asks for a new password twice. The reply to the request is
the same whether or not the address has an account, on purpose.

Two things must be true for the link to work, both set once in the
Supabase dashboard under Authentication → URL Configuration:

- **Site URL** is the deployed address (the `pages.dev` domain or your own).
- **Redirect URLs** include `https://<your domain>/reset-password` and, for
  local development, `http://localhost:5173/reset-password`.

A link that lands on the dashboard's default page instead of the app means
the redirect URL is not on that list. The email itself comes from the
project's default "Reset Password" template, which needs no change.

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
