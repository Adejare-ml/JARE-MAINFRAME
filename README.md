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
| Bank alerts | A Claude scheduled task reads Gmail and writes through two SQL functions (no Google token) |
| Other jobs | GitHub Actions cron; Ollama Cloud / NVIDIA NIM for the two that use a model |

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

Database schema changes live in `supabase/migrations/`. On a live project
apply only the new files, in order, through the Supabase SQL Editor or the
MCP (`apply_migration`). On a **fresh** project the order is not 001 upwards:
run `013_schema_baseline.sql` first, then 001–012, sign in to the app once
(014 needs an account to claim rows for), then 014 onwards. The early files
say "safe to re-run"; that stopped being true at 017, which made `user_id`
required: re-running 002 recreates a second `log_manual_transaction` next to
029's (QuickLog then fails with PGRST203), and re-running 009 narrows the
goal-metric check back. Do not re-run a file older than the newest one.

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

## How bank alerts become transactions

```
Gmail  ──▶  Claude scheduled task ("Daily spending audit", 08:00 UTC)
              │  one call per alert, through a read-write Supabase connector
              ▼
        ingest_alert_transaction(...)   ──▶   transactions (+ wallet balance)
              │
              └──▶  record_sync_run('claude-audit', ...)  ──▶  Settings → System
```

Every morning the owner's Claude scheduled task searches yesterday's mail
from the three bank senders through Claude's own Gmail connection, reads
each alert, and calls `ingest_alert_transaction` once per alert with the
slug, the Gmail message id, direction, amount, date, time, description,
payee, category, stated balance, an excerpt and a confidence. It then calls
`record_sync_run`, which is what Settings → System and the morning push
read. There is no Google token to keep alive, which is why the token-based
sync below was retired on 23 Sep 2026.

The function (`032_alert_ingest.sql`, hardened in `034_close_out.sql`) is
where every rule lives, so a prompt cannot skip one:

- the owner is pinned (`jare_owner`, 035), the wallet must exist by slug,
  the direction and amount are checked, and bad input comes back as
  `{"inserted": false, "reason": "refused", ...}` rather than an error;
- the id is `CLA-<gmail message id>`, unique per source, so a re-run inserts
  nothing; an alert the old sync already imported is refused by its natural
  key (same wallet, day, direction, amount, payee);
- free text is normalised and capped; a category the app does not know, an
  amount above ₦5m and a date more than a day ahead all land in the review
  queue at LOW confidence; the owner's category rules (Settings) are applied
  in priority order;
- a wallet balance follows the alert's stated balance forward only, and
  never from a future-dated alert.

Rows the task was sure about (HIGH) are reviewed on arrival; LOW ones wait in
the review queue on Transactions, exactly as before.

**The connector.** The standard Supabase connector in Claude cannot write:
its `execute_sql` runs as `supabase_read_only_user` inside a read-only
transaction and answers `permission denied for function`. The task uses a
second, custom connector on
`https://mcp.supabase.com/mcp?project_ref=<project ref>&features=database`
(no `read_only`), whose `execute_sql` runs as `postgres`. The functions are
granted to `postgres` and `service_role` only, so the browser's anon key
still cannot call them. `033_claude_audit_channel.sql` is an unused
fallback for sending a day as one `apply_migration` batch.

**The retired token sync.** `scripts/gmail-sync.mjs` and
`.github/workflows/gmail-sync.yml` still exist for a manual run with a fresh
Google refresh token, and only for dates **before 23 Sep 2026**: the script
does not know about `CLA-` ids, so a backfill over days the task already
covered inserts every alert a second time. The browser "Sync now" button
was removed for the same reason. The overnight day draft
(`draft-day.yml`, the "Today's shape" card on Daily HQ) was retired on
26 Sep 2026 for the same token; the task holds Claude's own Calendar
connection if a day brief is ever wanted back, and `012_day_brief.sql`
stays.

### Parse strategy

Only a manual run of the retired token sync reads this; the Claude task
decides direction itself. Each wallet chooses, in Settings → Banks & Wallets:

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

Three guards keep the ledger clean:

1. A unique index on `(source, transaction_id)`. The task's id is
   `CLA-<gmail message id>`, so the same alert read twice inserts nothing.
2. The natural key: an alert whose wallet, day, direction, amount and payee
   match a non-voided row from the old sync is refused as already imported.
   This runs one way only, which is why the old sync must not be run over
   days the task has covered.
3. For the retired sync's alerts that carry no bank reference, a synthetic
   `SYN-` id derived from the content with FNV-1a, identical in Node and the
   browser. `tests/dedup.test.js` guards that.

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

### A scheduled job cannot work out whose rows to write

`OWNER_USER_ID` is optional while the project has one account: the Actions
scripts look it up (`scripts/lib/ownerId.mjs`) and the database pins it
(`jare_owner`, migration 035), so a second account -- a test login, a stray
sign-up -- no longer stops the bank-alert task. If a script still refuses to
guess, set the `OWNER_USER_ID` repository secret to the owner's id
(`select id, email from auth.users;`). Turn sign-ups off in Supabase Auth
(Providers → Email) so nobody else gets an account in the first place.

Two Supabase projects with the same name are the other way this goes wrong:
the app, the Actions secrets, the Claude connector and the SQL editor must
all point at the same project ref. The Migrations page only lists migrations
applied through the CLI or MCP; anything pasted into the SQL editor never
appears there even when it worked, so check the banner in the app, not that
page.

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

### Bank alerts stopped arriving

Three places say so: Settings → System ("Bank alerts (Claude audit)" turns
orange after 30 hours or red on a failed run), the Needs Attention card on
Daily HQ, and the morning push, which leads with any failing or stale job.

In order:

1. claude.ai → Routines → "Daily spending audit": is it enabled, and did the
   last run finish? Its output ends with `N recorded / M already there / K
   skipped`.
2. Its connectors: Gmail authorised, and the custom read-write Supabase
   connector attached with `execute_sql` allowed. An output full of
   `permission denied for function` means it wrote through the standard
   read-only connector instead.
3. Run it by hand from the same page. Re-runs are safe: the function refuses
   a duplicate by Gmail message id. To cover missed days, add a note to the
   run asking for those dates as well.
4. `select * from sync_runs where job = 'claude-audit' order by finished_at
   desc limit 5;` shows what each run recorded; a `refused` in the summary
   names the alert and why.

## What runs on its own

| Job | When (UTC) | Needs | Records as |
|---|---|---|---|
| Bank-alert audit (Claude Routine) | 08:00 daily | Gmail + read-write Supabase connectors | `claude-audit` |
| Repo verification (`verify-repo.yml`) | 21:30 daily | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | `verify-repo` |
| Net-worth snapshot (`snapshot-net-worth.yml`) | 09:30 daily, dated yesterday | same | `snapshot-net-worth` |
| Morning reminder (`remind.yml`) | 08:20 daily | same, plus `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` once a phone has subscribed | `remind` |
| Weekly recap (`weekly-recap.yml`) | Monday 09:17 | same, plus `OLLAMA_KEY` or `NVIDIA_KEY` | `weekly-recap` |
| Month plan (`plan-month.yml`) | 1st, 05:17 | same, plus an LLM key | `plan-month` |
| Keep schedules alive (`keepalive.yml`) | 1st and 15th, 04:23 | `actions: write` (automatic) | — |

The last row exists because GitHub switches off every scheduled workflow in
a public repository after 60 days without a commit, silently. Making the
repository private removes that rule and also stops the Actions logs, which
print balances and bill names, from being world-readable; the keep-alive is
then harmless. Each Actions job records its run in `sync_runs`, opens or
reopens one `sync-failure` issue when it fails, and the morning reminder
repeats any failing or stale job at the top of its digest.

## Environment

See `.env.example`. In short: `VITE_`-prefixed variables are compiled into the
browser bundle and are public by design; everything else belongs in GitHub
Actions secrets and is never bundled.

Model IDs and endpoints are configurable so a renamed model needs a
repository *variable* change (Settings → Secrets and variables → Actions →
Variables; a secret of the same name is ignored) rather than a code change. Verify them with:

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
