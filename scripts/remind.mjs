/**
 * The morning reminder.
 *
 * Runs on a schedule from .github/workflows/remind.yml. Reads what the app
 * already knows needs attention -- debts due, bills expected, urgent
 * repairs, milestones past their date, rows waiting for review -- and
 * turns it into one short digest (src/lib/reminders.js).
 *
 * This stage prints the digest and records the run. Sending it to a phone
 * is the next two stages: a push_subscriptions table the app fills from
 * Settings, then web-push from here. Until then every run is a dry run, so
 * the schedule, the reads and the wording can be watched in the Actions
 * log before a single notification goes out.
 *
 * All the judgment lives in src/lib/reminders.js so it can be tested
 * without a network or a database. This file is wiring.
 */

import { createClient } from '@supabase/supabase-js'
import { buildReminderDigest } from '../src/lib/reminders.js'
import { toDateOnly, daysAgo } from '../src/lib/queries.js'
import { resolveOwnerUserId } from './lib/ownerId.mjs'
import { recordRun } from './lib/recordRun.mjs'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

/** Print the digest and stop. Always on until sending exists. */
const DRY_RUN = process.env.REMIND_DRY_RUN === '1' || process.env.REMIND_DRY_RUN === 'true'

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
// 3. Run
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

  // Sending lands with the push subscriptions (Stages 20-21). Until then
  // the digest above is the whole output, dry run or not.
  console.log(DRY_RUN ? 'Dry run: nothing sent.' : 'No delivery channel yet: nothing sent.')
}

main()
  .then(() => recordRun(supabase, { job: JOB, userId: OWNER_USER_ID, startedAt: RUN_STARTED_AT, ok: process.exitCode !== 1 }))
  .catch(async (err) => {
    console.error('❌ Reminder digest failed:', err?.message || err)
    await recordRun(supabase, { job: JOB, userId: OWNER_USER_ID, startedAt: RUN_STARTED_AT, ok: false, summary: err?.message || String(err) })
    process.exit(1)
  })
