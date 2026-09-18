/**
 * Snapshot every wallet's balance, once a day.
 *
 * Runs on a schedule from .github/workflows/snapshot-net-worth.yml. This is
 * the only place a wallet's balance is ever written down anywhere but the
 * `wallets` row itself, which only ever holds the current figure -- the
 * moment it changes, what it used to be is gone. Net worth over time cannot
 * be computed after the fact from a table that never kept the "before".
 *
 * Deliberately the simplest of the five scheduled scripts: one table, one
 * read, one upsert, no external API, no LLM. It does NOT call
 * assertProgress.mjs -- unlike gmail-sync.mjs, every failure path here
 * already throws (the query error, the upsert error) and is caught by
 * main().catch() below, the same shape verify-repo.mjs already has and
 * needed no correctness-spine change for. A write that finds zero active
 * wallets still writes a ₦0 snapshot rather than skipping -- a flat day is
 * data, a missing day is a gap a chart cannot tell apart from "the cron
 * didn't run" -- so there is no "found data but wrote nothing" shape for
 * this script to silently fall into.
 */

import { createClient } from '@supabase/supabase-js'
import { toDateOnly } from '../src/lib/queries.js'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

/**
 * Whose rows these are.
 *
 * Required, not optional, and that is the whole point. This script writes with
 * the service-role key, which bypasses RLS and has no `auth.uid()` -- so a row
 * it inserts without `user_id` is a row that migration 015's policy makes
 * invisible to you in the app, with no error anywhere. Treating this as
 * optional would turn a missing repository secret into silently vanishing data,
 * which is this project's signature failure.
 *
 * Get it from: select id from auth.users;
 */
const OWNER_USER_ID = process.env.OWNER_USER_ID

const missingVars = [
  ['OWNER_USER_ID', OWNER_USER_ID],
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
const today = toDateOnly(new Date())

// ───────────────────────────────────────────────────────────────
// 2. Run
// ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`💰 Snapshotting net worth for ${today}`)

  const { data: wallets, error } = await supabase
    .from('wallets')
    .select('id, balance, is_active')
    .eq('is_active', true)

  if (error) throw error

  // A day with zero active wallets is a real, if unlikely, state -- not a
  // reason to skip writing. A flat ₦0 snapshot is data; a missing day is a
  // gap a chart cannot tell apart from "the cron didn't run".
  const byWallet = {}
  let totalBalance = 0
  for (const w of wallets || []) {
    const balance = Number(w.balance) || 0
    byWallet[w.id] = balance
    totalBalance += balance
  }

  console.log(`   ${(wallets || []).length} active wallet(s), total ${totalBalance}`)

  const { error: upsertError } = await supabase
    .from('wallet_snapshots')
    .upsert(
      {
        user_id: OWNER_USER_ID,
        snapshot_date: today,
        total_balance: totalBalance,
        by_wallet: byWallet,
      },
      { onConflict: 'user_id,snapshot_date' },
    )

  if (upsertError) throw upsertError

  console.log(`✅ Snapshot written for ${today}`)
}

main().catch((err) => {
  console.error('❌ Net worth snapshot failed:', err?.message || err)
  process.exit(1)
})
