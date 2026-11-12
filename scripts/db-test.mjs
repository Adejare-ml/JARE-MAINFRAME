/**
 * The migration harness: every SQL file, applied to a real Postgres, then
 * the functions exercised the way the Routine and the app call them.
 *
 * The bank-alert rules live in ingest_alert_transaction and the nightly
 * checks in reconcile_balances and snapshot_net_worth, and until this
 * existed no test executed any of them: 1,000 vitest cases guarded the
 * JavaScript and the SQL shipped blind onto the only copy of the ledger.
 * This applies the 44 files in the README's fresh-project order (013,
 * then 001 to 012, then an account, then 014 onwards) with the Supabase
 * pieces stubbed (tests/sql/supabase-stubs.sql, tests/sql/pg_cron-stub),
 * and asserts what the functions answer and what they write.
 *
 * Needs a Postgres 16 it may create and drop a database on, reachable
 * through the usual PG* variables or DATABASE_URL, and the pg_cron stub
 * installed in that server's extension directory (the CI job does both;
 * locally see README, "Testing the SQL"). Never point it at the live
 * project: it drops and recreates the database it is told to use.
 *
 *   PGHOST=... PGPORT=... PGUSER=postgres npm run test:db
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'
import { readReconcileSummary } from '../src/lib/health.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const TEST_DB = process.env.JARE_TEST_DB || 'jare_migration_test'
const OWNER = '11111111-1111-4111-8111-111111111111'
const CLAIMS = JSON.stringify({ sub: OWNER, role: 'authenticated' })

const { Client } = pg

/** Admin connection string (to the maintenance database), from the env. */
function adminConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL }
  return { database: process.env.PGDATABASE || 'postgres' }
}

function testConfig() {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL)
    url.pathname = `/${TEST_DB}`
    return { connectionString: url.toString() }
  }
  return { database: TEST_DB }
}

// ───────────────────────────────────────────────────────────────
// 1. Apply
// ───────────────────────────────────────────────────────────────

/** The README's fresh-project order. */
function orderedMigrations() {
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()
  const num = (f) => Number(f.slice(0, 3))
  const baseline = files.filter((f) => num(f) === 13)
  const early = files.filter((f) => num(f) >= 1 && num(f) <= 12)
  const later = files.filter((f) => num(f) >= 14)
  if (baseline.length !== 1) throw new Error('expected exactly one 013 baseline migration')
  return { baseline: baseline[0], early, later, all: files }
}

async function recreateDatabase() {
  const admin = new Client(adminConfig())
  await admin.connect()
  try {
    const { rows } = await admin.query('select current_database() as db')
    if (rows[0].db === TEST_DB) throw new Error(`the admin connection must not be to ${TEST_DB} itself`)
    await admin.query(`drop database if exists ${quoteIdent(TEST_DB)} with (force)`)
    await admin.query(`create database ${quoteIdent(TEST_DB)}`)
  } finally {
    await admin.end()
  }
}

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe database name: ${name}`)
  return `"${name}"`
}

async function applyFile(client, file, dir = MIGRATIONS) {
  const sql = readFileSync(join(dir, file), 'utf8')
  try {
    await client.query(sql)
  } catch (err) {
    err.message = `${file}: ${err.message}${err.where ? `\n  where: ${err.where}` : ''}${err.hint ? `\n  hint: ${err.hint}` : ''}`
    throw err
  }
}

async function applyAll(client) {
  const order = orderedMigrations()
  await applyFile(client, 'supabase-stubs.sql', join(ROOT, 'tests', 'sql'))
  await applyFile(client, order.baseline)
  for (const f of order.early) await applyFile(client, f)
  // "sign in to the app once (014 needs an account to claim rows for)"
  await client.query('insert into auth.users (id, email) values ($1, $2)', [OWNER, 'owner@example.test'])
  await client.query("select set_config('request.jwt.claims', $1, false)", [CLAIMS])
  for (const f of order.later) await applyFile(client, f)
  return order.all.length
}

// ───────────────────────────────────────────────────────────────
// 2. Assertions
// ───────────────────────────────────────────────────────────────

const results = []
let client

async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`   ✓ ${name}`)
  } catch (err) {
    results.push({ name, ok: false, error: err })
    console.log(`   ✗ ${name}\n     ${String(err?.message || err).split('\n').join('\n     ')}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const q = async (sql, params = []) => (await client.query(sql, params)).rows
const one = async (sql, params = []) => (await q(sql, params))[0]
const num = (v) => Number(v)

/** The Routine's call, in the order the prompt fills it. */
async function ingest(args) {
  const {
    slug, msgid, type, amount, date, time = null, description = null, recipient = null,
    category = 'Uncategorized', balance = null, excerpt = null, confidence = 'HIGH',
  } = args
  const row = await one(
    'select ingest_alert_transaction($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) as r',
    [slug, msgid, type, amount, date, time, description, recipient, category, balance, excerpt, confidence],
  )
  return row.r
}

const today = () => one("select (now() at time zone 'Africa/Lagos')::date::text as d").then((r) => r.d)
const daysAgo = (n) => one("select ((now() at time zone 'Africa/Lagos')::date - $1::int)::text as d", [n]).then((r) => r.d)

async function wallet(slug) {
  return one('select id, name, balance::float8 as balance, balance_as_of from wallets where source_slug = $1', [slug])
}

async function runChecks() {
  const TODAY = await today()

  await check('the pinned owner is the one account (035)', async () => {
    const row = await one('select jare_sole_owner() as id')
    eq(row.id, OWNER, 'jare_sole_owner()')
    const pinned = await one('select user_id from jare_owner')
    eq(pinned.user_id, OWNER, 'jare_owner.user_id')
  })

  await check('041 seeded the three newer banks for the owner', async () => {
    const rows = await q("select source_slug from wallets where user_id = $1 and source_slug in ('palmpay','zenith','piggyvest') order by 1", [OWNER])
    eq(rows.map((r) => r.source_slug).join(','), 'palmpay,piggyvest,zenith', 'seeded slugs')
  })

  // GTBank and OPay were made by hand on the live project; make them here.
  await client.query(
    `insert into wallets (user_id, name, type, balance, source_slug, alert_sender)
     values ($1, 'GTBank', 'bank', 0, 'gtbank', 'gens@gtbank.com'),
            ($1, 'OPay', 'mobile', 0, 'opay', 'no-reply@opay-nigeria.com')`,
    [OWNER],
  )

  await check('a stated-balance debit is recorded HIGH, reviewed, and sets the wallet balance', async () => {
    const r = await ingest({ slug: 'gtbank', msgid: 'm1', type: 'debit', amount: 2500, date: TODAY, time: '09:00:00', description: 'POS purchase', recipient: 'SHOPRITE', category: 'Feeding / Groceries', balance: 97500 })
    eq(r.inserted, true, 'inserted')
    eq(r.reviewed, true, 'reviewed')
    eq(r.category, 'Feeding / Groceries', 'category')
    const w = await wallet('gtbank')
    eq(w.balance, 97500, 'wallet balance')
    eq(w.balance_as_of, `${TODAY}T09:00:00`, 'balance_as_of')
    const t = await one("select transaction_id, source, reviewed, confidence from transactions where alert_message_id = 'm1' or transaction_id = 'CLA-m1'")
    eq(t.transaction_id, 'CLA-m1', 'transaction_id')
    eq(t.source, 'gtbank', 'source')
  })

  await check('the same Gmail message a second time is a duplicate, whatever else it says', async () => {
    const r = await ingest({ slug: 'gtbank', msgid: 'm1', type: 'credit', amount: 999, date: TODAY, balance: 1 })
    eq(r.inserted, false, 'inserted')
    eq(r.reason, 'duplicate', 'reason')
    eq((await wallet('gtbank')).balance, 97500, 'balance untouched')
  })

  await check('a credit is recorded like a debit and the balance follows it forward', async () => {
    const r = await ingest({ slug: 'gtbank', msgid: 'm2', type: 'credit', amount: 50000, date: TODAY, time: '10:00:00', description: 'Salary', recipient: 'ACME LTD', category: 'Salary', balance: 147500 })
    eq(r.inserted, true, 'inserted')
    eq((await wallet('gtbank')).balance, 147500, 'balance followed the later alert')
  })

  await check('an older stated balance never moves the wallet backwards', async () => {
    const r = await ingest({ slug: 'gtbank', msgid: 'm0', type: 'debit', amount: 100, date: await daysAgo(1), time: '08:00:00', description: 'Stamp duty', category: 'Bank Charges', balance: 97600 })
    eq(r.inserted, true, 'inserted')
    eq((await wallet('gtbank')).balance, 147500, 'balance kept the newer alert')
  })

  await check('an alert that states no balance moves the wallet by its amount (balance_derived)', async () => {
    await client.query("update wallets set balance = 10000 where source_slug = 'palmpay'")
    const r = await ingest({ slug: 'palmpay', msgid: 'p1', type: 'debit', amount: 1500, date: TODAY, time: '11:00:00', description: 'Transfer Successful', recipient: 'BOLT', category: 'Transport' })
    eq(r.inserted, true, 'inserted')
    assert(r.flags.includes('balance_derived'), `flags: ${JSON.stringify(r.flags)}`)
    eq((await wallet('palmpay')).balance, 8500, 'balance derived')
  })

  await check('bad input is refused with a reason, never an error', async () => {
    eq((await ingest({ slug: 'gtbank', msgid: 'x1', type: 'withdrawal', amount: 10, date: TODAY })).reason, 'refused', 'bad type')
    eq((await ingest({ slug: 'gtbank', msgid: 'x2', type: 'debit', amount: -5, date: TODAY })).reason, 'refused', 'negative amount')
    eq((await ingest({ slug: 'gtbank', msgid: '', type: 'debit', amount: 5, date: TODAY })).reason, 'refused', 'no message id')
  })

  await check('an unknown category, a huge amount and a stale date all land in review as LOW', async () => {
    const r1 = await ingest({ slug: 'gtbank', msgid: 'm3', type: 'debit', amount: 300, date: TODAY, time: '10:30:00', category: 'Not A Category', balance: 147200 })
    eq(r1.category, 'Uncategorized', 'unknown category')
    eq(r1.reviewed, false, 'unknown category waits for review')
    assert(r1.flags.some((f) => f.startsWith('unknown_category:')), `flags: ${JSON.stringify(r1.flags)}`)
    const r2 = await ingest({ slug: 'gtbank', msgid: 'm4', type: 'debit', amount: 6000000, date: TODAY, category: 'Rent', balance: 147200 })
    eq(r2.reviewed, false, 'large amount waits for review')
    assert(r2.flags.includes('large_amount'), `flags: ${JSON.stringify(r2.flags)}`)
    const r3 = await ingest({ slug: 'gtbank', msgid: 'm5', type: 'debit', amount: 20, date: await daysAgo(20), category: 'Bank Charges', balance: 147180 })
    assert(r3.flags.includes('stale_date'), `flags: ${JSON.stringify(r3.flags)}`)
    // m4 states no time, so on a day that already has a timed balance it
    // does not move it (036: never backwards, and midnight is earlier than
    // 10:30); m5 is older than the wallet's balance_as_of. 147,200 stands.
    eq((await wallet('gtbank')).balance, 147200, 'neither the untimed nor the stale alert moves the balance')
  })

  await check('a transfer to a third party is not a transfer; to one of my own names it is (036/038)', async () => {
    const r1 = await ingest({ slug: 'gtbank', msgid: 'm6', type: 'debit', amount: 5000, date: TODAY, time: '11:00:00', recipient: 'MAMA KITCHEN', category: 'Transfer Out', balance: 142200 })
    eq(r1.category, 'Uncategorized', 'third party')
    eq(r1.reviewed, false, 'third party waits for review')
    assert(r1.flags.includes('third_party_transfer:Transfer Out'), `flags: ${JSON.stringify(r1.flags)}`)
    await client.query("update jare_owner set own_names = array['DANIEL ADEJARE']")
    const r2 = await ingest({ slug: 'gtbank', msgid: 'm7', type: 'debit', amount: 5000, date: TODAY, time: '11:10:00', recipient: 'OPAY DANIEL ADEJARE', category: 'Transfer Out', balance: 137200 })
    eq(r2.category, 'Transfer Out', 'own name')
    eq(r2.reviewed, true, 'own name is HIGH')
  })

  await check("the owner's category rule files the alert on arrival (038)", async () => {
    await client.query(
      "insert into category_rules (user_id, trigger_field, trigger_value, action_category, priority) values ($1, 'recipient', 'netflix', 'Subscriptions', 0)",
      [OWNER],
    )
    const r = await ingest({ slug: 'gtbank', msgid: 'm8', type: 'debit', amount: 4400, date: TODAY, time: '11:20:00', recipient: 'NETFLIX.COM', category: 'Uncategorized', balance: 132800 })
    eq(r.category, 'Subscriptions', 'rule category')
    assert(r.flags.some((f) => f.startsWith('rule:')), `flags: ${JSON.stringify(r.flags)}`)
  })

  await check('a repayment to a tracked debt is linked and filed as Loan Repayment (039)', async () => {
    await client.query(
      "insert into debts (user_id, direction, kind, counterparty, principal, match_payee) values ($1, 'i_owe', 'loan', 'OKash', 45000, 'okash')",
      [OWNER],
    )
    const r = await ingest({ slug: 'gtbank', msgid: 'm9', type: 'debit', amount: 15000, date: TODAY, time: '11:30:00', recipient: 'OKASH NIGERIA', category: 'Uncategorized', balance: 117800 })
    eq(r.category, 'Loan Repayment', 'category')
    assert(r.debt_id, 'debt_id set')
    const d = await one('select counterparty from debts where id = $1', [r.debt_id])
    eq(d.counterparty, 'OKash', 'linked debt')
  })

  await check('a QuickLog entry is matched by its later bank alert instead of a second row (039)', async () => {
    const w = await wallet('gtbank')
    const before = w.balance
    const m = await one(
      "select log_manual_transaction($1, $2, 'debit', 1000, 'Data / Airtime', 'MTN top-up', null, $3::date, '12:00:00'::time, null) as r",
      ['test-1', w.id, TODAY],
    )
    eq(m.r.inserted, true, 'manual inserted')
    eq((await wallet('gtbank')).balance, before - 1000, 'manual moved the wallet')
    const r = await ingest({ slug: 'gtbank', msgid: 'm10', type: 'debit', amount: 1000, date: TODAY, time: '12:01:00', recipient: 'MTN', category: 'Data / Airtime', balance: before - 1000 })
    eq(r.reason, 'matched manual entry', 'reason')
    const n = await one("select count(*)::int as n from transactions where wallet_id = $1 and amount = 1000 and transaction_date = $2", [w.id, TODAY])
    eq(n.n, 1, 'one row, not two')
    const linked = await one("select alert_message_id from transactions where transaction_id = 'MAN-test-1'")
    eq(linked.alert_message_id, 'm10', 'manual row carries the message id')
  })

  await check('an unrelated alert of the same amount no longer swallows a QuickLog that names another payee (046)', async () => {
    // Until 046 the match ignored the payee, so this POS alert vanished into
    // the airtime row and the POS spend never reached the ledger.
    const w = await wallet('gtbank')
    await client.query(
      "select log_manual_transaction($1, $2, 'debit', 1000, 'Data / Airtime', 'Airtel top-up', null, $3::date, '13:00:00'::time, null)",
      ['test-2', w.id, TODAY],
    )
    const r = await ingest({ slug: 'gtbank', msgid: 'm11', type: 'debit', amount: 1000, date: TODAY, time: '13:30:00', recipient: 'SHOPRITE POS', category: 'Feeding / Groceries', balance: w.balance - 2000 })
    eq(r.inserted, true, 'a new row, not a match')
    const airtel = await one("select alert_message_id from transactions where transaction_id = 'MAN-test-2'")
    eq(airtel.alert_message_id, null, 'the airtime row is untouched')
    const r2 = await ingest({ slug: 'gtbank', msgid: 'm12', type: 'debit', amount: 1000, date: TODAY, time: '13:45:00', recipient: 'AIRTEL NG', category: 'Data / Airtime', balance: w.balance - 2000 })
    eq(r2.reason, 'matched manual entry', 'the Airtel alert matches the Airtel row')
    const after = await one("select alert_message_id from transactions where transaction_id = 'MAN-test-2'")
    eq(after.alert_message_id, 'm12', 'stamped with its own alert')
  })

  await check('a QuickLog with no note still matches any alert of its amount (046)', async () => {
    const w = await wallet('gtbank')
    await client.query(
      "select log_manual_transaction($1, $2, 'debit', 750, 'Miscellaneous', null, null, $3::date, '14:00:00'::time, null)",
      ['test-3', w.id, TODAY],
    )
    const r = await ingest({ slug: 'gtbank', msgid: 'm13', type: 'debit', amount: 750, date: TODAY, time: '14:10:00', recipient: 'ANY SHOP', category: 'Feeding / Groceries', balance: w.balance - 750 })
    eq(r.reason, 'matched manual entry', 'blank note matches')
  })

  await check('an alert from a bank the owner does not track is refused and names the nearest slug, without minting an account (048)', async () => {
    const r = await ingest({ slug: 'gt-bank', msgid: 'k0', type: 'debit', amount: 20, date: TODAY, description: 'typo', balance: 1 })
    eq(r.inserted, false, 'inserted')
    eq(r.discovered, false, 'a refusal notes nothing')
    eq(r.nearest, 'gtbank', 'nearest known slug')
    const n = await one("select count(*)::int as n from discovered_accounts where slug in ('gtbank', 'gt-bank')")
    eq(n.n, 0, 'no junk discovered account')
  })

  await check('the explicit note creates the discovered account; Track makes the wallet and the next alert lands (043)', async () => {
    const noted = (await one("select note_discovered_account('kuda', 'Kuda <no-reply@kuda.com>', 'Kuda', 52000, $1::date, 'k1') as r", [TODAY])).r
    eq(noted.noted, true, 'noted')
    const d = await one("select id, status, last_balance::float8 as last_balance, times_seen, asked_at, snooze_until from discovered_accounts where slug = 'kuda'")
    eq(d.status, 'new', 'status')
    eq(d.last_balance, 52000, 'last balance')
    eq(d.asked_at, null, 'asked_at starts null (048)')
    eq(d.snooze_until, null, 'snooze_until starts null (048)')
    const a = await one('select adopt_discovered_account($1, $2, $3) as r', [d.id, 'Kuda', 'bank'])
    assert(a.r && (a.r.ok !== false), `adopt: ${JSON.stringify(a.r)}`)
    const r2 = await ingest({ slug: 'kuda', msgid: 'k1', type: 'credit', amount: 20000, date: TODAY, description: 'Kuda credit', balance: 52000 })
    eq(r2.inserted, true, 'after Track the alert lands')
    eq((await wallet('kuda')).balance, 52000, 'tracked wallet balance')
  })

  await check('a statement mail for a tracked slug keeps the balance on the wallet, forward only (048)', async () => {
    const r = (await one("select note_discovered_account('kuda', null, null, 60000, $1::date, 'k2') as r", [TODAY])).r
    eq(r.noted, false, 'not a new account')
    eq(r.reason, 'already a wallet', 'reason')
    // Same day as the timed alert above: 036's rule, a day-dated statement never overrides it.
    eq(r.balance_noted, false, 'same-day statement does not override a timed alert')
    eq((await wallet('kuda')).balance, 52000, 'balance kept')
    await client.query("update wallets set balance_as_of = $1 where source_slug = 'kuda'", [`${await daysAgo(3)}T09:00:00`])
    const r2 = (await one("select note_discovered_account('kuda', null, null, 60000, $1::date, 'k3') as r", [await daysAgo(1)])).r
    eq(r2.balance_noted, true, 'a newer statement is kept')
    eq((await wallet('kuda')).balance, 60000, 'balance from the statement')
    // Put the wallet back where its alerts left it: a statement balance with
    // no alert behind it is exactly the disagreement reconcile reports.
    await client.query("update wallets set balance = 52000, balance_as_of = $1 where source_slug = 'kuda'", [`${TODAY}T00:00:00`])
  })

  await check('record_sync_run stores the run, caps the summary at 500, and stamps the mailbox cursor on an ok audit', async () => {
    await client.query("insert into integrations (user_id, service) values ($1, 'gmail') on conflict do nothing", [OWNER]).catch(() => {})
    const long = 'x'.repeat(700)
    const r = await one("select record_sync_run('claude-audit', true, $1) as id", [long])
    assert(r.id, 'run id')
    const row = await one('select job, ok, length(summary) as len from sync_runs where id = $1', [r.id])
    eq(row.job, 'claude-audit', 'job')
    eq(num(row.len), 500, 'summary cap')
    const cursor = await one("select last_checked from integrations where service = 'gmail'")
    assert(cursor && cursor.last_checked, 'last_checked stamped')
  })

  await check("reconcile_balances agrees with a clean ledger, in the words health.js parses", async () => {
    const r = (await one('select reconcile_balances() as r')).r
    assert(typeof r.summary === 'string', 'summary')
    const report = readReconcileSummary(r.summary)
    assert(report, `health.js could not read: ${r.summary}`)
    eq(report.drifts.length, 0, `drifts in: ${r.summary}`)
    const run = await one("select ok, summary from sync_runs where job = 'reconcile' order by finished_at desc limit 1")
    eq(run.summary, r.summary, 'recorded summary')
  })

  await check('reconcile_balances names a wallet whose consecutive alerts do not chain (a missed alert)', async () => {
    // Zenith: 100,000 stated, then a 5,000 debit that claims 80,000 left.
    await ingest({ slug: 'zenith', msgid: 'z1', type: 'credit', amount: 100000, date: await daysAgo(3), time: '09:00:00', description: 'Salary', category: 'Salary', balance: 100000 })
    await ingest({ slug: 'zenith', msgid: 'z2', type: 'debit', amount: 5000, date: await daysAgo(2), time: '09:00:00', description: 'POS', category: 'Feeding / Groceries', balance: 80000 })
    const r = (await one('select reconcile_balances() as r')).r
    eq(r.ok, false, 'ok')
    const report = readReconcileSummary(r.summary)
    assert(report && report.gaps.some((g) => g.startsWith('Zenith')), `gaps: ${JSON.stringify(report?.gaps)} in: ${r.summary}`)
    assert(/missed alert\(s\) around/.test(r.summary), 'the phrase the Routine prompt searches for')
  })

  await check('reconcile carries a no-balance alert and a manual entry between two stated balances (047)', async () => {
    // OPay: 10,000 stated; a PalmPay-style no-balance debit of 1,500 and a
    // QuickLog of 2,000 in between; then 6,500 stated. 040 called the 6,500 a gap.
    await ingest({ slug: 'opay', msgid: 'o1', type: 'credit', amount: 10000, date: await daysAgo(3), time: '09:00:00', description: 'Wallet funded', category: 'Transfer In', balance: 10000 })
    await ingest({ slug: 'opay', msgid: 'o2', type: 'debit', amount: 1500, date: await daysAgo(2), time: '09:00:00', description: 'Transfer Successful', recipient: 'BOLT', category: 'Transport' })
    const w = await wallet('opay')
    await client.query(
      "select log_manual_transaction($1, $2, 'debit', 2000, 'Feeding / Groceries', 'Market', null, $3::date, '12:00:00'::time, null)",
      ['test-o3', w.id, await daysAgo(2)],
    )
    await ingest({ slug: 'opay', msgid: 'o4', type: 'debit', amount: 1000, date: await daysAgo(1), time: '09:00:00', description: 'Transfer Successful', recipient: 'BOLT', category: 'Transport', balance: 5500 })
    const r = (await one('select reconcile_balances() as r')).r
    const report = readReconcileSummary(r.summary)
    assert(report, `health.js could not read: ${r.summary}`)
    assert(!report.gaps.some((g) => g.startsWith('OPay')), `OPay reported as a gap: ${r.summary}`)
    assert(!report.drifts.some((g) => g.startsWith('OPay')), `OPay reported as a drift: ${r.summary}`)
  })

  await check('reconcile names a wallet whose alerts never state a balance, and caps a long gap list (047)', async () => {
    await ingest({ slug: 'piggyvest', msgid: 'pv1', type: 'credit', amount: 5000, date: await daysAgo(1), time: '09:00:00', description: 'has been added to your Flex', category: 'Savings Transfer' })
    // GTBank: seven more stated balances that each break the chain.
    for (let d = 0; d < 7; d++) {
      await ingest({ slug: 'gtbank', msgid: `gap${d}`, type: 'debit', amount: 10, date: await daysAgo(9 - d), time: '08:00:00', description: 'Charge', category: 'Bank Charges', balance: 90000 - d * 1000 })
    }
    const r = (await one('select reconcile_balances() as r')).r
    assert(/unverifiable \(no stated balance\): [^;]*PiggyVest/.test(r.summary), `PiggyVest not named: ${r.summary}`)
    assert(Array.isArray(r.unverified) && r.unverified.includes('PiggyVest'), 'unverified in the result')
    assert(/GTBank: \d+ missed alert\(s\) around [^;]* and \d+ more day\(s\)/.test(r.summary), `gap list not capped: ${r.summary}`)
    assert(r.summary.length <= 500, `summary is ${r.summary.length} characters`)
    const report = readReconcileSummary(r.summary)
    assert(report.gaps.some((g) => g.startsWith('GTBank')), 'health.js still reads the capped gap line')
    assert(report.other.some((o) => o.startsWith('unverifiable')), 'health.js reads the unverifiable note as a plain note')
  })

  await check('snapshot_net_worth writes one dated row and records its run (037)', async () => {
    const r = (await one('select snapshot_net_worth() as r')).r
    assert(r && r.ok !== false, `snapshot: ${JSON.stringify(r)}`)
    const row = await one('select count(*)::int as n from wallet_snapshots where user_id = $1', [OWNER])
    assert(row.n >= 1, 'snapshot row')
    const run = await one("select ok from sync_runs where job = 'snapshot-net-worth' order by finished_at desc limit 1")
    eq(run.ok, true, 'run ok')
  })

  await check('the two pg_cron schedules exist as the migrations wrote them', async () => {
    const rows = await q('select jobname, schedule from cron.job order by jobname')
    eq(rows.map((r) => `${r.jobname}@${r.schedule}`).join(' '), 'reconcile-balances@30 10 * * * snapshot-net-worth@0 10 * * *', 'cron jobs')
  })

  await check('the browser roles cannot call the audit functions, and can call the manual-entry RPCs (044)', async () => {
    const fns = [
      ['ingest_alert_transaction(text, text, text, numeric, date, time, text, text, text, numeric, text, text)', false],
      ['record_sync_run(text, boolean, text, timestamptz)', false],
      ['reconcile_balances(integer)', false],
      ['snapshot_net_worth(date)', false],
      ['log_manual_transaction(text, uuid, text, numeric, text, text, text, date, time, uuid)', true],
      ['correct_transaction(uuid, text, numeric, date, text, text, text, boolean)', true],
      ['log_wallet_transfer(text, uuid, uuid, numeric, text, text, text, date, time)', true],
    ]
    for (const [sig, authenticatedMay] of fns) {
      const anon = await one("select has_function_privilege('anon', $1, 'execute') as ok", [sig])
      eq(anon.ok, false, `anon may execute ${sig}`)
      const auth = await one("select has_function_privilege('authenticated', $1, 'execute') as ok", [sig])
      eq(auth.ok, authenticatedMay, `authenticated may execute ${sig}`)
    }
  })

  await check('every table in public has row level security on, with at least one policy', async () => {
    const rows = await q(`
      select c.relname, c.relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' order by 1`)
    const noRls = rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)
    eq(noRls.join(','), '', 'tables without RLS')
    // jare_owner is revoked from every role and has no policy on purpose (035).
    const noPolicy = rows.filter((r) => r.relrowsecurity && r.policies === 0 && r.relname !== 'jare_owner').map((r) => r.relname)
    eq(noPolicy.join(','), '', 'tables with RLS but no policy')
  })

  // ── Diet (048-050), added for the Diet module, Phase 1 ──────────────────
  // These run as the signed-in owner (role authenticated, the owner's
  // claims), the way the browser calls them, so RLS and the grants are
  // part of what is tested. Expected figures come from the 049 seed:
  // egg 155 kcal / 12.6 g protein per 100 g, boiled plantain 116 / 0.8,
  // Beans pot 802.772 kcal / 45.87 g protein per portion.
  const asOwner = async (fn) => {
    await client.query('set role authenticated')
    try {
      return await fn()
    } finally {
      await client.query('reset role')
    }
  }
  const foodId = async (name) => (await one('select id from foods where lower(name) = $1', [name])).id
  const logDiet = async (clientId, meal, items) =>
    (await one('select log_diet_meal($1, $2::jsonb, $3::jsonb) as r', [clientId, JSON.stringify(meal), JSON.stringify(items)])).r

  await check('log_diet_meal prices a saved meal from its foods and sums the meal, once per client id (048, 049)', async () => {
    await asOwner(async () => {
      const saved = await one("select id, items from saved_meals where name = '3 boiled eggs + 1 plantain'")
      assert(saved, 'the 049 saved meal is missing')
      // The client sends only references and amounts, plus a figure it has
      // no business sending; the database prices the items itself.
      const items = saved.items.map((i) => ({ ...i, kcal: 9999 }))
      const meal = { eaten_at: '2026-11-09T07:00:00Z', meal_slot: 'breakfast', source: 'saved', saved_meal_id: saved.id }
      const first = await logDiet('db-test-saved-1', meal, items)
      eq(first.inserted, true, 'inserted')
      // 233 (150 g egg) + 209 (180 g plantain); 18.9 + 1.4 g protein
      eq(first.kcal, 442, 'kcal')
      eq(Number(first.protein_g), 20.3, 'protein_g')
      const again = await logDiet('db-test-saved-1', meal, items)
      eq(again.inserted, false, 'a retry inserts nothing')
      eq(again.reason, 'duplicate', 'reason')
      const n = await one("select count(*)::int as n from meal_logs where client_id = 'db-test-saved-1'")
      eq(n.n, 1, 'meal_logs rows for one client id')
    })
  })

  await check('a Beans pot portion logs at 803 kcal and 45.9 g protein, and the day is the sum of its items (048, 049)', async () => {
    await asOwner(async () => {
      const recipe = await one("select id from recipes where name = 'Beans pot'")
      const r = await logDiet('db-test-pot-1', { eaten_at: '2026-11-09T12:30:00Z', meal_slot: 'lunch' }, [
        { recipe_id: recipe.id, portions: 1 },
        { food_id: await foodId('orange'), grams: 130 },
        { name: 'Zobo from the office', grams: 350, kcal: 160, carbs_g: 39.5 },
      ])
      // 803 + 61 (130 g orange) + 160 (kept: no food behind it)
      eq(r.kcal, 1024, 'kcal')
      const pot = await one("select grams, kcal, protein_g from meal_items where meal_id = $1 and recipe_id is not null", [r.id])
      eq(pot.kcal, 803, 'pot kcal')
      eq(Number(pot.protein_g), 45.9, 'pot protein')
      eq(Number(pot.grams), 300.8, 'pot grams (raw weight / 5; no cooked weight recorded)')

      // The Daily Sheet's done-criterion, against the database: the day's
      // total in diet_daily_totals equals the sum of every item that day.
      const items = await one(
        `select sum(i.kcal)::int as kcal, sum(i.protein_g) as protein_g from meal_items i
           join meal_logs l on l.id = i.meal_id where l.eaten_on = '2026-11-09'`,
      )
      const day = await one("select kcal, protein_g, meals from diet_daily_totals where eaten_on = '2026-11-09'")
      eq(day.kcal, items.kcal, 'view kcal vs sum of items')
      eq(Number(day.protein_g), Number(items.protein_g), 'view protein vs sum of items')
      eq(day.kcal, 442 + 1024, 'day kcal')
      eq(day.meals, 2, 'meals that day')

      // Editing grams re-prices the item and re-sums the meal.
      await client.query("update meal_items set grams = 260 where meal_id = $1 and name = 'Orange'", [r.id])
      const edited = await one('select kcal from meal_logs where id = $1', [r.id])
      eq(edited.kcal, 803 + 122 + 160, 'after editing the orange to 260 g')
    })
  })

  await check('a late meal is filed under its Lagos day, and the 7-day average skips unlogged days (048)', async () => {
    await asOwner(async () => {
      // 23:30 UTC on the 11th is 00:30 on the 12th in Lagos.
      const late = await logDiet('db-test-late-1', { eaten_at: '2026-11-11T23:30:00Z', meal_slot: 'snacks' }, [
        { food_id: await foodId('groundnuts, roasted'), grams: 30 },
      ])
      const row = await one('select eaten_on::text as d, kcal from meal_logs where id = $1', [late.id])
      eq(row.d, '2026-11-12', 'eaten_on')
      eq(row.kcal, 176, 'kcal of 30 g groundnuts')
      // Logged days: the 9th (1,551 after the edit above) and the 12th (176).
      // The 10th and 11th are unlogged and must not count as zero.
      const avg = await one("select days_logged::int as n, kcal from diet_7day_average where eaten_on = '2026-11-12'")
      eq(avg.n, 2, 'days logged in the window')
      eq(avg.kcal, Math.round((442 + 1085 + 176) / 2), 'average kcal')
    })
  })

  await check('old Meals rows are copied into meal_logs with the same calories, once (050)', async () => {
    await asOwner(async () => {
      await client.query(
        `select log_meal('db-test-legacy-1', '[{"name":"Jollof rice","calories":600,"protein_g":12,"grams":400},
                                              {"name":"Akara","calories":80,"quantity":3}]'::jsonb,
                         '2026-11-01'::date, '13:15'::time, 'lunch', 'from the old page', 'text')`,
      )
      await client.query(`select log_meal('db-test-legacy-2', '[{"name":"Coke","calories":210}]'::jsonb, '2026-11-01'::date, null, 'snack')`)
    })
    // The migration runs as postgres, from the SQL editor; twice, to prove
    // a re-run copies nothing twice.
    await applyFile(client, '050_diet_backfill.sql')
    await applyFile(client, '050_diet_backfill.sql')
    const logs = await q(
      `select l.meal_slot, l.source, l.kcal, l.raw_text, to_char(l.eaten_at at time zone 'Africa/Lagos', 'HH24:MI') as t,
              (select count(*)::int from meal_items i where i.meal_id = l.id) as items
         from meal_logs l join meals m on m.id = l.legacy_meal_id
        where m.client_id like 'db-test-legacy-%' order by l.kcal desc`,
    )
    eq(logs.length, 2, 'copied meals')
    eq(logs[0].kcal, 840, 'jollof meal kcal (600 + 3 x 80)')
    eq(logs[0].items, 2, 'jollof meal items')
    eq(logs[0].t, '13:15', 'Lagos time kept')
    eq(logs[0].source, 'text', 'source')
    eq(logs[0].raw_text, 'from the old page', 'note carried into raw_text')
    eq(logs[1].meal_slot, 'snacks', "'snack' becomes 'snacks'")
    eq(logs[1].t, '12:00', 'no time kept: noon')
    const akara = await one("select grams, kcal, estimates->'legacy_042'->>'name' as orig from meal_items where name = 'Akara'")
    eq(akara.kcal, 240, 'akara x3')
    eq(akara.orig, 'Akara', 'original item kept under estimates.legacy_042')
  })

  // ── Diet, Phase 2 (051): pantry updates from a sentence, and flags ──────
  const applyPantry = async (clientId, updates, raw = null) =>
    (await one('select apply_pantry_updates($1, $2::jsonb, $3) as r', [clientId, JSON.stringify(updates), raw])).r

  await check('apply_pantry_updates: bought, used, finished, and a retry that applies nothing twice (051)', async () => {
    await asOwner(async () => {
      const beans = await foodId('brown beans, dry')
      const egg = await foodId('egg, boiled')
      const bought = await applyPantry('db-test-pantry-1', [
        { action: 'bought', name: 'beans', food_id: beans, quantity: 2, unit: 'kg', cost_naira: 3000 },
        { action: 'bought', name: 'eggs', food_id: egg, quantity: 30, unit: 'eggs', cost_naira: 5400 },
      ], 'bought 2 kg beans for 3,000 and a crate of eggs for 5,400')
      eq(bought.applied, 2, 'applied')
      const row = await one("select quantity, unit, cost_naira, finished from pantry_items where food_id = $1", [beans])
      eq(Number(row.quantity), 2, 'beans quantity')
      eq(Number(row.cost_naira), 3000, 'beans cost')

      const again = await applyPantry('db-test-pantry-1', [
        { action: 'bought', name: 'beans', food_id: beans, quantity: 2, unit: 'kg', cost_naira: 3000 },
        { action: 'bought', name: 'eggs', food_id: egg, quantity: 30, unit: 'eggs', cost_naira: 5400 },
      ])
      eq(again.applied, 0, 'a retry applies nothing')
      eq(again.duplicates, 2, 'duplicates')
      const n = await one('select count(*)::int as n from pantry_items where food_id = $1', [beans])
      eq(n.n, 1, 'beans rows after a retry')

      const used = await applyPantry('db-test-pantry-2', [{ action: 'used', name: 'eggs', food_id: egg, quantity: 3 }])
      eq(used.results[0].outcome, 'reduced', 'used outcome')
      eq(Number((await one('select quantity from pantry_items where food_id = $1', [egg])).quantity), 27, 'eggs left')

      // "eggs finished", matched by name with no food id.
      const done = await applyPantry('db-test-pantry-3', [{ action: 'finished', name: 'Eggs' }])
      eq(done.results[0].outcome, 'finished', 'finished outcome')
      eq((await one('select finished from pantry_items where food_id = $1', [egg])).finished, true, 'eggs finished')

      const nothing = await applyPantry('db-test-pantry-4', [{ action: 'finished', name: 'garri' }])
      eq(nothing.results[0].outcome, 'recorded', 'finishing something not in the pantry changes nothing')
      const events = await one("select count(*)::int as n from pantry_events where client_id like 'db-test-pantry-%'")
      eq(events.n, 5, 'ledger rows')
    })
  })

  await check('log_diet_meal stores the parser flags and marks the meal for review (051)', async () => {
    await asOwner(async () => {
      const r = await logDiet('db-test-text-1', { meal_slot: 'lunch', source: 'text', raw_text: 'mama put rice and stew' }, [
        { food_id: await foodId('white rice, boiled'), grams: 300, estimates: { claude_text: { grams: 300 } } },
        { name: 'Mama put stew', grams: 120, kcal: 180, flagged: true, flag_reason: 'Not in your foods list' },
      ])
      const meal = await one('select source, raw_text, needs_review, kcal from meal_logs where id = $1', [r.id])
      eq(meal.source, 'text', 'source')
      eq(meal.needs_review, true, 'needs_review')
      eq(meal.kcal, 390 + 180, 'kcal')
      const flagged = await one("select flagged, flag_reason, estimates from meal_items where meal_id = $1 and name = 'Mama put stew'", [r.id])
      eq(flagged.flagged, true, 'flagged')
      eq(flagged.flag_reason, 'Not in your foods list', 'flag_reason')
      const rice = await one("select estimates->'claude_text'->>'grams' as g from meal_items where meal_id = $1 and food_id is not null", [r.id])
      eq(rice.g, '300', 'the model estimate kept beside the final numbers')
    })
  })

  // ── Diet, Phase 3 (052): photos, per-model estimates, replacing items ──
  await check('meal-photos: the owner may write only inside their own folder, and the bucket is private (052)', async () => {
    const bucket = await one("select public from storage.buckets where id = 'meal-photos'")
    eq(bucket.public, false, 'bucket public')
    await asOwner(async () => {
      await client.query("insert into storage.objects (bucket_id, name) values ('meal-photos', $1)", [`${OWNER}/2026/11/a.jpg`])
      let refused = false
      try {
        await client.query("insert into storage.objects (bucket_id, name) values ('meal-photos', '22222222-2222-4222-8222-222222222222/2026/11/b.jpg')")
      } catch {
        refused = true
      }
      assert(refused, "the owner wrote into another account's folder")
      const mine = await one("select count(*)::int as n from storage.objects where bucket_id = 'meal-photos'")
      eq(mine.n, 1, 'objects the owner can see')
    })
  })

  await check('meal_estimates holds one row per model per meal, and diet_replace_items swaps the items in one go (052)', async () => {
    await asOwner(async () => {
      const r = await logDiet('db-test-photo-1', { meal_slot: 'lunch', source: 'photo', status: 'auto' }, [{ food_id: await foodId('white rice, boiled'), grams: 250 }])
      await client.query("insert into meal_estimates (meal_id, model_key, model_id, status, answer, latency_ms) values ($1, 'claude', 'claude-sonnet-5-5', 'ok', '{\"items\": []}', 6100)", [r.id])
      await client.query("insert into meal_estimates (meal_id, model_key, status, reason) values ($1, 'ollama', 'error', 'laptop off') on conflict (meal_id, model_key) do update set status = 'skipped'", [r.id])
      let dup = false
      try {
        await client.query("insert into meal_estimates (meal_id, model_key, status, answer) values ($1, 'claude', 'ok', '{}')", [r.id])
      } catch {
        dup = true
      }
      assert(dup, 'a second claude estimate for one meal was accepted')

      const out = (await one('select diet_replace_items($1, $2::jsonb, $3::jsonb) as r', [
        r.id,
        JSON.stringify([
          { food_id: await foodId('white rice, boiled'), grams: 200, estimates: { claude: { grams: 250 }, nvidia: { grams: 180 } } },
          { name: 'Chicken, grilled', grams: 120, kcal: 250, protein_g: 30, flagged: true, flag_reason: 'Only Claude saw this' },
        ]),
        JSON.stringify({ status: 'confirmed', meal_slot: 'dinner' }),
      ])).r
      eq(out.status, 'confirmed', 'status')
      eq(out.kcal, 260 + 250, 'kcal re-summed from the new items')
      const meal = await one('select meal_slot, needs_review, (select count(*)::int from meal_items where meal_id = $1) as n from meal_logs where id = $1', [r.id])
      eq(meal.meal_slot, 'dinner', 'slot')
      eq(meal.n, 2, 'items after replacing')
      eq(meal.needs_review, true, 'a flagged item marks the meal for review')
    })
    // The edge function's service role does the same for the worker's re-merge.
    await client.query('set role service_role')
    try {
      const m = await one("select id from meal_logs where client_id = 'db-test-photo-1'")
      const res = (await one("select diet_replace_items($1, $2::jsonb) as r", [m.id, JSON.stringify([{ name: 'Rice', grams: 100, kcal: 130 }])])).r
      eq(res.kcal, 130, 'service role re-merge kcal')
      const owner = await one('select user_id::text as u from meal_items where meal_id = $1', [m.id])
      eq(owner.u, OWNER, "replaced items keep the meal's owner")
    } finally {
      await client.query('reset role')
    }
  })

  await check('a second account sees no Diet rows, through the tables or the views (048)', async () => {
    const other = '33333333-3333-4333-8333-333333333333'
    await client.query('insert into auth.users (id, email) values ($1, $2)', [other, 'diet-stranger@example.test'])
    await client.query('set role authenticated')
    await client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: other, role: 'authenticated' })])
    try {
      for (const t of ['meal_logs', 'meal_items', 'foods', 'recipes', 'saved_meals', 'diet_settings', 'pantry_items', 'pantry_events', 'meal_estimates', 'diet_daily_totals', 'diet_7day_average']) {
        const seen = await one(`select count(*)::int as n from ${t}`)
        eq(seen.n, 0, `${t} rows visible to a stranger`)
      }
      // And the stranger cannot price an item off the owner's foods: the
      // food is invisible, so the item keeps only what was sent.
      const ownerFood = '00000000-0000-4000-8000-000000000000'
      const r = await logDiet('db-test-stranger-1', { meal_slot: 'lunch' }, [{ food_id: ownerFood, name: 'x', grams: 100, kcal: 5 }])
      eq(r.kcal, 5, 'stranger meal kcal')
      // Nor replace the owner's items (052): the owner's meal is invisible.
      const ownerMeal = (await client.query("select id from meal_logs limit 1")).rows[0]
      eq(ownerMeal?.id ?? null, (await one("select id from meal_logs where client_id = 'db-test-stranger-1'")).id, 'the only meal a stranger sees is their own')
      const photo = await one("select count(*)::int as n from storage.objects where bucket_id = 'meal-photos'")
      eq(photo.n, 0, "the owner's photos visible to a stranger")
    } finally {
      await client.query('reset role')
      await client.query("select set_config('request.jwt.claims', $1, false)", [CLAIMS])
      await client.query('delete from meal_logs where user_id = $1', [other])
      await client.query('delete from auth.users where id = $1', [other])
    }
  })

  await check('a second account cannot read or write the owner rows through RLS', async () => {
    const other = '22222222-2222-4222-8222-222222222222'
    await client.query('insert into auth.users (id, email) values ($1, $2)', [other, 'stranger@example.test'])
    await client.query("set role authenticated")
    await client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: other, role: 'authenticated' })])
    try {
      const seen = await one('select count(*)::int as n from transactions')
      eq(seen.n, 0, 'rows visible to a stranger')
      const w = await one('select count(*)::int as n from wallets')
      eq(w.n, 0, 'wallets visible to a stranger')
      let blocked = false
      try {
        await client.query("update wallets set balance = 0")
        const still = await q('select 1 from wallets')
        blocked = still.length === 0
      } catch {
        blocked = true
      }
      assert(blocked, 'stranger could update wallets')
    } finally {
      await client.query('reset role')
      await client.query("select set_config('request.jwt.claims', $1, false)", [CLAIMS])
      await client.query('delete from auth.users where id = $1', [other])
    }
  })
}

// ───────────────────────────────────────────────────────────────
// 3. Run
// ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`🗄️  Migration harness on database ${TEST_DB}`)
  await recreateDatabase()
  client = new Client(testConfig())
  await client.connect()
  try {
    const count = await applyAll(client)
    console.log(`   ${count} migrations applied in the fresh-project order (013, 001-012, account, 014+)`)
    results.push({ name: 'every migration applies', ok: true })
    await runChecks()
  } finally {
    await client.end()
  }
  const failed = results.filter((r) => !r.ok)
  console.log('─'.repeat(64))
  console.log(`${results.length - failed.length} passed, ${failed.length} failed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(`❌ ${err?.message || err}`)
  process.exit(1)
})
