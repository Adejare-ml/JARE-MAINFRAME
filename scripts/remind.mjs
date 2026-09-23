/**
 * The morning reminder.
 *
 * Runs on a schedule from .github/workflows/remind.yml. Reads what the app
 * already knows needs attention -- debts due, bills expected, urgent
 * repairs, milestones past their date, rows waiting for review -- and
 * turns it into one short digest (src/lib/reminders.js).
 *
 * Then sends it, as one web push, to every device that turned reminders
 * on in Settings -> Reminders (push_subscriptions, migration 031). A push
 * service answering 404 or 410 means the device is gone and its row is
 * deleted; any other failure is stamped on the row and tried again next
 * morning. A run that had devices and a digest and reached none of them
 * fails, so the Actions issue says so.
 *
 * REMIND_DRY_RUN=1 prints what would be sent and to how many devices,
 * without sending -- the way to watch a morning before trusting it.
 *
 * All the judgment lives in src/lib/reminders.js so it can be tested
 * without a network or a database. This file is wiring.
 */

import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import { buildReminderDigest, toPushPayload, classifySendError } from '../src/lib/reminders.js'
import { toDateOnly, daysAgo } from '../src/lib/queries.js'
import { resolveOwnerUserId } from './lib/ownerId.mjs'
import { recordRun } from './lib/recordRun.mjs'
import { assertProgress } from './lib/assertProgress.mjs'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env

/** Print the digest and who would get it, then stop. */
const DRY_RUN = process.env.REMIND_DRY_RUN === '1' || process.env.REMIND_DRY_RUN === 'true'

/** A contact for the push services, per the VAPID spec. Not a secret. */
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'https://github.com/Adejare-ml/JARE-MAINFRAME'

/** Six hours: a reminder that could not be delivered by lunchtime is
 *  tomorrow's problem, not a stale ping at midnight. */
const PUSH_TTL_SECONDS = 6 * 60 * 60

/** How far back to look for recurring bills. detectRecurring needs three
 *  occurrences, so four months covers a monthly bill with one missed. */
const BILL_LOOKBACK_DAYS = Number(process.env.REMIND_LOOKBACK_DAYS) || 120

/** Whose rows these are -- see verify-repo.mjs for why this is resolved
 *  at run time and never guessed. */
let OWNER_USER_ID = process.env.OWNER_USER_ID

const JOB = 'remind'
const RUN_STARTED_AT = new Date()

const missingVars = [
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_SERVICE_KEY', SUPABASE_SERVICE_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name)

if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// ───────────────────────────────────────────────────────────────
// 2. Reads
// ───────────────────────────────────────────────────────────────

/**
 * A table that may not exist yet (repairs before 027, projects before 026)
 * costs its part of the digest, not the run -- the same additive rule the
 * other scripts apply to debts and day_briefs.
 */
async function optional(label, query) {
  const { data, error } = await query
  if (error) {
    console.warn(`   (${label} unavailable: ${error.message})`)
    return []
  }
  return data || []
}

async function readEverything(today) {
  const [debts, transactions, unreviewed, repairs, projects, milestones] = await Promise.all([
    optional('debts', supabase.from('debts').select('*').eq('user_id', OWNER_USER_ID).eq('settled', false)),
    optional(
      'transactions',
      supabase
        .from('transactions')
        .select('type, amount, category, wallet_id, transaction_date, recipient, description, voided')
        .eq('user_id', OWNER_USER_ID)
        .eq('voided', false)
        .gte('transaction_date', daysAgo(BILL_LOOKBACK_DAYS))
        .lte('transaction_date', today),
    ),
    supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', OWNER_USER_ID)
      .eq('voided', false)
      .eq('reviewed', false),
    optional('repairs', supabase.from('repairs').select('*').eq('user_id', OWNER_USER_ID).neq('status', 'done')),
    optional('projects', supabase.from('projects').select('id, name, status').eq('user_id', OWNER_USER_ID).eq('status', 'active')),
    optional('milestones', supabase.from('milestones').select('project_id, title, due_date, completed').eq('user_id', OWNER_USER_ID).eq('completed', false)),
  ])

  if (unreviewed.error) console.warn(`   (review count unavailable: ${unreviewed.error.message})`)

  return {
    debts,
    transactions,
    unreviewedCount: unreviewed.error ? 0 : unreviewed.count || 0,
    repairs,
    projects,
    milestones,
    today,
  }
}

// ───────────────────────────────────────────────────────────────
// 3. Send
// ───────────────────────────────────────────────────────────────

async function readSubscriptions() {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, user_agent')
    .eq('user_id', OWNER_USER_ID)
  if (error) {
    // A database behind 031 has no devices, which is a fact, not a failure.
    if (!/relation .* does not exist|could not find the table/i.test(error.message || '')) {
      console.warn(`   (push_subscriptions unavailable: ${error.message})`)
    }
    return []
  }
  return data || []
}

/**
 * One push per device. Returns what happened to each so the summary and
 * the exit code can be honest about it.
 */
async function sendToAll(subscriptions, payload) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
  const now = new Date().toISOString()
  const outcome = { sent: 0, gone: 0, failed: 0 }

  for (const row of subscriptions) {
    const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }
    try {
      await webpush.sendNotification(subscription, payload, { TTL: PUSH_TTL_SECONDS })
      outcome.sent++
      await supabase.from('push_subscriptions').update({ last_used_at: now }).eq('id', row.id)
      console.log(`   ✓ sent   ${describe(row)}`)
    } catch (err) {
      const verdict = classifySendError(err?.statusCode)
      if (verdict === 'gone') {
        outcome.gone++
        await supabase.from('push_subscriptions').delete().eq('id', row.id)
        console.log(`   ✗ gone   ${describe(row)} (${err.statusCode}) -- row removed`)
      } else {
        outcome.failed++
        await supabase.from('push_subscriptions').update({ failed_at: now }).eq('id', row.id)
        console.log(`   ✗ failed ${describe(row)} (${err?.statusCode || err?.message || 'no status'}) -- will retry tomorrow`)
      }
    }
  }
  return outcome
}

const describe = (row) => `${(row.user_agent || 'unknown device').slice(0, 60)} …${row.endpoint.slice(-12)}`

// ───────────────────────────────────────────────────────────────
// 4. Run
// ───────────────────────────────────────────────────────────────

async function main() {
  OWNER_USER_ID = await resolveOwnerUserId(supabase, OWNER_USER_ID)
  const today = toDateOnly(new Date())
  console.log(`🔔 Reminder digest for ${today}${DRY_RUN ? ' (dry run)' : ''}`)

  const input = await readEverything(today)
  console.log(
    `   read: ${input.debts.length} open debt(s), ${input.transactions.length} transaction(s), ` +
      `${input.unreviewedCount} to review, ${input.repairs.length} open repair(s), ` +
      `${input.projects.length} active project(s), ${input.milestones.length} open milestone(s)`,
  )

  const digest = buildReminderDigest(input)

  console.log('─'.repeat(64))
  if (!digest) {
    console.log('Nothing needs you today. No digest, on purpose.')
    console.log('─'.repeat(64))
    return
  }

  console.log(`📣 ${digest.title}`)
  console.log(`   ${digest.body}`)
  console.log(`   → ${digest.url}`)
  console.log('')
  for (const item of digest.items) console.log(`   • [${item.kind}] ${item.text}`)
  console.log('─'.repeat(64))

  const subscriptions = await readSubscriptions()
  if (subscriptions.length === 0) {
    console.log('No device has turned reminders on (Settings → Reminders). Nothing to send to.')
    return
  }

  const payload = toPushPayload(digest)
  if (DRY_RUN) {
    console.log(`Dry run: would send ${payload.length}-byte payload to ${subscriptions.length} device(s):`)
    for (const row of subscriptions) console.log(`   · ${describe(row)}`)
    return
  }

  const haveKeys = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
  if (!haveKeys) {
    console.log(`${subscriptions.length} device(s) waiting, but VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set.`)
    console.log('   Generate them with `node scripts/generate-vapid.mjs` and add the Actions secrets.')
  }

  const outcome = haveKeys ? await sendToAll(subscriptions, payload) : { sent: 0, gone: 0, failed: 0 }
  console.log(`\n📱 ${outcome.sent} sent, ${outcome.gone} gone (removed), ${outcome.failed} failed (kept)`)

  // Devices were waiting and a digest existed: reaching none of them is
  // the one outcome the error handling above cannot see on its own.
  assertProgress([
    { ok: haveKeys, reason: 'devices are subscribed but the VAPID keys are not configured' },
    {
      ok: !haveKeys || outcome.sent > 0 || outcome.gone === subscriptions.length,
      reason: `no device received the digest (${outcome.failed} failed, ${outcome.gone} gone)`,
    },
  ])
}

main()
  .then(() => recordRun(supabase, { job: JOB, userId: OWNER_USER_ID, startedAt: RUN_STARTED_AT, ok: process.exitCode !== 1 }))
  .catch(async (err) => {
    console.error('❌ Reminder digest failed:', err?.message || err)
    await recordRun(supabase, { job: JOB, userId: OWNER_USER_ID, startedAt: RUN_STARTED_AT, ok: false, summary: err?.message || String(err) })
    process.exit(1)
  })
