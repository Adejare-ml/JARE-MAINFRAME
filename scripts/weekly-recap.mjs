/**
 * Turn the week that just ended into a few sentences, grounded the same way
 * the month planner is.
 *
 * Runs on a schedule from .github/workflows/weekly-recap.yml, after the week
 * closes. What it writes is not a fresh computation -- it is prose over
 * numbers that already exist. `compareWeeks` (src/lib/weekreview.js) and
 * `currentStreak` (src/lib/activity.js) are the same functions WeekReview.jsx
 * renders from, so the recap and the card sitting above it can never disagree
 * about what happened.
 *
 * The model never sees a transaction. It sees a short list of facts, each
 * with a fixed set of numbers it is allowed to mention, and it may only turn
 * them into sentences -- src/lib/recapReview.js throws away anything that
 * cites a fact that does not exist or states a number that fact does not
 * have. This project has shipped model output that looked fine and could
 * never have worked; a wrong figure next to a real citation is exactly that
 * shape of bug, and it is the one src/lib/recapReview.js is built to make
 * structurally impossible rather than merely unlikely.
 *
 * A week with nothing worth saying writes an empty recap. That is a correct
 * answer, not a failure -- see reviewRecap's own test for the same point
 * reviewPlan's makes about a quiet month.
 */

import { createClient } from '@supabase/supabase-js'
import { compareWeeks } from '../src/lib/weekreview.js'
import { currentStreak } from '../src/lib/activity.js'
import { isTaskDone, goalProgress } from '../src/lib/planning.js'
import { buildWeekFacts, buildRecapPrompt, RECAP_SYSTEM_PROMPT } from '../src/lib/recapPrompt.js'
import { reviewRecap } from '../src/lib/recapReview.js'
import { endOfWeek, weeksAgo, daysAgo } from '../src/lib/queries.js'
import { callModel, hasAnyProvider, LLM_CONFIG } from './llm.mjs'
import { assertProgress } from './lib/assertProgress.mjs'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

/** A recap is a handful of sentences. A long budget only buys room to ramble. */
const RECAP_MAX_TOKENS = 500

/** Days of daily-task history fetched to compute the streak. Comfortably past
 *  any real streak without pulling the whole table. */
const STREAK_LOOKBACK_DAYS = 60

/**
 * Whose rows these are.
 *
 * Required, not optional, and that is the whole point. This script writes
 * with the service-role key, which bypasses RLS and has no `auth.uid()` -- so
 * a row it inserts without `user_id` is a row that migration 015's policy
 * makes invisible to you in the app, with no error anywhere. Treating this as
 * optional would turn a missing repository secret into silently vanishing
 * data, which is this project's signature failure.
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

if (!hasAnyProvider()) {
  // Named rather than implied. The secrets in this repository are OLLAMA_KEY
  // and NVIDIA_KEY, and an unset secret resolves to an empty string with no
  // error -- the same silent-degradation failure this project has already
  // shipped once, in categorization.
  console.error('❌ No LLM provider configured. Set OLLAMA_KEY or NVIDIA_KEY.')
  console.error(`   ollama: ${LLM_CONFIG.ollama.configured}, nvidia: ${LLM_CONFIG.nvidia.configured}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// The run happens after the week has closed, so "the week" means the one that
// just ended -- last week from today's point of view -- not the week in
// progress, which has nothing to recap yet.
const now = new Date()
const weekStart = weeksAgo(1, now)
const weekEnd = endOfWeek(new Date(`${weekStart}T00:00:00`))
const priorWeekStart = weeksAgo(2, now)

// ───────────────────────────────────────────────────────────────
// 2. Evidence
// ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`🗓️  Recapping week of ${weekStart}`)

  const [walletsRes, txRes, dailyRes, weeklyGoalsRes] = await Promise.all([
    supabase.from('wallets').select('id, type, is_active'),
    supabase
      .from('transactions')
      .select('type, amount, category, wallet_id, transaction_date, voided')
      .eq('voided', false)
      .gte('transaction_date', priorWeekStart)
      .lte('transaction_date', weekEnd),
    supabase
      .from('goals')
      // verified_at/evidence included: without them a repo-commit goal's
      // progress (repoProgress() in planning.js) reads as unchecked/zero
      // regardless of what the nightly verifier actually found.
      .select('id, title, period, target_date, metric, target_amount, metric_category, metric_wallet_id, completed, verified_at, evidence')
      .eq('period', 'daily')
      .gte('target_date', daysAgo(STREAK_LOOKBACK_DAYS, now))
      .lte('target_date', weekEnd),
    supabase
      .from('goals')
      .select('id, title, period, target_date, metric, target_amount, metric_category, metric_wallet_id, completed, verified_at, evidence')
      .eq('period', 'weekly')
      .eq('target_date', weekStart),
  ])

  if (walletsRes.error) throw walletsRes.error
  if (txRes.error) throw txRes.error
  if (dailyRes.error) throw dailyRes.error
  if (weeklyGoalsRes.error) throw weeklyGoalsRes.error

  const liquidWalletIds = new Set(
    (walletsRes.data || []).filter((w) => ['bank', 'mobile', 'cash'].includes(w.type)).map((w) => w.id),
  )

  const transactions = txRes.data || []
  const thisWeekTx = transactions.filter((t) => t.transaction_date >= weekStart && t.transaction_date <= weekEnd)
  const lastWeekTx = transactions.filter((t) => t.transaction_date >= priorWeekStart && t.transaction_date < weekStart)

  const comparison = compareWeeks(thisWeekTx, lastWeekTx, liquidWalletIds)

  // Streak as of the end of the recapped week, not today -- a recap written
  // days late must still describe the week it is about. `liveToday: false`
  // is what makes that safe: currentStreak's own "today" is forgiven if
  // incomplete because the day is still in progress, but weekEnd is a
  // Sunday that has already closed by the time this Monday cron runs -- a
  // real miss on it must break the streak, not be silently excused.
  const dailyTasks = dailyRes.data || []
  const doneOn = (task) => isTaskDone(task, transactions.filter((t) => t.transaction_date === task.target_date))
  const streak = currentStreak(dailyTasks, doneOn, { today: weekEnd, liveToday: false })

  const weeklyGoals = (weeklyGoalsRes.data || []).map((goal) => {
    const progress = goalProgress(goal, thisWeekTx)
    return { id: goal.id, title: goal.title, metric: goal.metric, measured: progress.measured, done: progress.done, target: progress.target }
  })

  const facts = buildWeekFacts({ comparison, streak, weeklyGoals })
  console.log(`   ${facts.length} fact(s) to recap: ${facts.map((f) => f.key).join(', ') || '(none)'}`)

  if (facts.length === 0) {
    console.log('   Nothing measurable this week. Writing an empty recap.')
    const { error } = await supabase
      .from('week_recaps')
      .upsert(
        { user_id: OWNER_USER_ID, week_start: weekStart, sentences: [], model: null, drafted_at: new Date().toISOString() },
        { onConflict: 'week_start' },
      )
    if (error) throw error
    console.log('✅ Empty recap recorded')
    return
  }

  const answer = await callModel(buildRecapPrompt(facts), {
    system: RECAP_SYSTEM_PROMPT,
    maxTokens: RECAP_MAX_TOKENS,
    label: 'weekly-recap',
  })

  if (!answer) {
    // callModel returns null only when every configured provider failed, not
    // when the model legitimately declined -- reviewRecap's own rejection
    // path below handles that. assertProgress at the end is what turns this
    // into a failed run rather than a silently empty one.
    console.log('   no answer from any provider; nothing drafted')
    assertProgress([{ ok: false, reason: 'no LLM provider answered for the weekly recap -- Ollama and NVIDIA may both be down or misconfigured' }])
    return
  }

  const { accepted, rejected } = reviewRecap(answer.data?.sentences, facts)

  // Printed, always. Gatekeeping nobody can see is gatekeeping nobody trusts
  // -- the same reasoning plan-month.mjs's rejection log follows.
  for (const { item, reason } of rejected) {
    console.log(`   ✗ "${item.sentence ?? '(no sentence)'}" — ${reason}`)
  }

  const { error } = await supabase
    .from('week_recaps')
    .upsert(
      {
        user_id: OWNER_USER_ID,
        week_start: weekStart,
        sentences: accepted,
        model: answer.provider,
        drafted_at: new Date().toISOString(),
      },
      { onConflict: 'week_start' },
    )
  if (error) throw error

  console.log('─'.repeat(64))
  for (const s of accepted) console.log(`   ✓ ${s.sentence}`)
  console.log(`✅ ${accepted.length} sentence(s) kept of ${accepted.length + rejected.length} proposed`)
  // A provider that answered and had every sentence rejected is the review
  // step doing its job, not a script failure -- reviewPlan's own rejection
  // path in plan-month.mjs gets the same pass. assertProgress already ran,
  // above, for the one thing that IS this script's business: no answer at all.
}

main().catch((err) => {
  console.error('❌ Weekly recap failed:', err?.message || err)
  process.exit(1)
})
