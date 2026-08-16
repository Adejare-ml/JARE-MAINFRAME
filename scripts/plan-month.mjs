/**
 * Draft a month of work from a monthly goal.
 *
 * Runs on a schedule from .github/workflows/plan-month.yml, in the Action
 * rather than the browser for the same reason the Gmail sync does: browser code
 * cannot hold an API key.
 *
 * What it produces is a PROPOSAL. Every row it writes carries
 * `plan_status = 'draft'`, which `excludeDrafts` filters out of every screen
 * except the one that asks you to approve it. That is not politeness -- it is
 * the only honest arrangement. This is the first thing in the app whose output
 * cannot be checked by re-doing the arithmetic, and something that can be
 * confidently wrong must not be able to change what you see in the morning
 * without you having looked at it.
 *
 * The plan is grounded twice over, and refuses to write anything that is not:
 *
 *   From the repository. buildRepoProfile turns `git ls-files` into facts --
 *   these paths exist, these have no test file.
 *
 *   From you. Gaps you logged after leaning on an agent for something you did
 *   not understand. The prompt is told to prefer these, because a gap is
 *   something you have already said is true about yourself, and a path is only
 *   a file.
 *
 * reviewPlan then throws away every item that cannot cite one of those, and the
 * rejections are printed with their reasons. A run that accepts two of six
 * items has to look different from a model that only offered two, or the
 * gatekeeping is invisible and might as well not be running.
 *
 * The arithmetic keeps its job. This writes `focus` -- the words -- and never
 * `target_amount`. How much is still remaining ÷ periods left, recomputed by
 * planning.js every time, and a model never gets to move a number.
 */

import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { buildRepoProfile, describeRepo } from '../src/lib/repoProfile.js'
import { buildPlanPrompt, PLAN_SYSTEM_PROMPT } from '../src/lib/planPrompt.js'
import { reviewPlan, planWeeks, PLAN_STATUS } from '../src/lib/planReview.js'
import { GENERATED_SLOT_BASE, REPO_METRIC } from '../src/lib/planning.js'
import { startOfMonth, startOfWeek, endOfMonth, toDateOnly } from '../src/lib/queries.js'
import { callModel, hasAnyProvider, LLM_CONFIG } from './llm.mjs'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

/**
 * Slots the planner may use.
 *
 * Above the generated range, so a draft can never land on a row the arithmetic
 * generator owns. 009's `goals_generated_slot_range` already stops a generated
 * row entering the hand-typed 0-9; this keeps the third writer out of the
 * second's way by the same logic.
 */
const PLAN_SLOT_BASE = GENERATED_SLOT_BASE + 20

/** A month of plan is a short answer. A long budget only buys room to ramble. */
const PLAN_MAX_TOKENS = 900

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

if (!hasAnyProvider()) {
  // Named rather than implied. The secrets in this repository are OLLAMA_KEY
  // and NVIDIA_KEY, and an unset secret resolves to an empty string with no
  // error -- which is how categorization silently degraded to
  // Uncategorized/LOW on every run for weeks while a working key sat in
  // settings.
  console.error('❌ No LLM provider configured. Set OLLAMA_KEY or NVIDIA_KEY.')
  console.error(`   ollama: ${LLM_CONFIG.ollama.configured}, nvidia: ${LLM_CONFIG.nvidia.configured}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const today = toDateOnly(new Date())
const monthStart = startOfMonth(new Date(`${today}T00:00:00`))

// ───────────────────────────────────────────────────────────────
// 2. Evidence
// ───────────────────────────────────────────────────────────────

/**
 * The repository as git sees it.
 *
 * `git ls-files` rather than a directory walk: it respects .gitignore for free,
 * so `node_modules` and `dist` never appear, and it lists what is actually
 * committed rather than what happens to be on the runner's disk.
 */
function listRepoFiles() {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    console.warn(`⚠️  Could not list repository files: ${err.message}`)
    return []
  }
}

// ───────────────────────────────────────────────────────────────
// 3. Run
// ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`🗓️  Planning ${monthStart}`)

  const profile = buildRepoProfile(listRepoFiles())
  console.log(
    `   repository: ${profile.sourceCount} source, ${profile.testCount} tests, ` +
      `${profile.untested.length} module(s) with no test file`,
  )

  const [goalsRes, gapsRes] = await Promise.all([
    supabase
      .from('goals')
      .select('id, title, period, target_date, metric, target_amount, plan_status')
      .eq('period', 'monthly')
      .eq('target_date', monthStart)
      .eq('plan_status', PLAN_STATUS.ACTIVE),
    supabase
      .from('knowledge_gaps')
      .select('id, topic, note')
      .is('resolved_at', null)
      .order('created_at', { ascending: false }),
  ])

  if (goalsRes.error) throw goalsRes.error

  // Gaps are additive, not load-bearing: a missing table means 011 has not run
  // for that half, and a plan from the repository alone is still worth having.
  if (gapsRes.error) console.warn(`⚠️  Knowledge gaps unavailable: ${gapsRes.error.message}`)
  const gaps = gapsRes.error ? [] : gapsRes.data || []

  // Only coding goals. A savings goal decomposes perfectly well without a
  // model, and asking one to plan a month of saving money would produce advice
  // it has no evidence for -- which is the whole thing this stage is built to
  // avoid.
  const goals = (goalsRes.data || []).filter((g) => g.metric === REPO_METRIC)

  if (goals.length === 0) {
    console.log('\nNo active monthly coding goal for this month. Nothing to plan.')
    return
  }

  const weeks = planWeeks(monthStart, startOfWeek, endOfMonth)
  const evidence = { paths: profile.paths, gaps }
  console.log(`   ${weeks.length} week(s) to plan, ${gaps.length} open gap(s)\n`)

  let written = 0

  for (const goal of goals) {
    console.log(`── ${goal.title} ──`)

    const answer = await callModel(
      buildPlanPrompt({ goal, repoText: describeRepo(profile), gaps, weeks: weeks.length }),
      { system: PLAN_SYSTEM_PROMPT, maxTokens: PLAN_MAX_TOKENS, label: 'planning' },
    )

    if (!answer) {
      console.log('   no answer from any provider; nothing drafted\n')
      continue
    }

    const { accepted, rejected } = reviewPlan(answer.data?.weeks, evidence, { weeks: weeks.length })

    // Printed, always. Gatekeeping nobody can see is gatekeeping nobody trusts,
    // and "the model proposed six and two were kept" is the single most useful
    // line in this log.
    for (const { item, reason } of rejected) {
      console.log(`   ✗ week ${item.week ?? '?'}: ${reason}`)
    }

    if (accepted.length === 0) {
      console.log(`   ${answer.provider}: nothing survived review; no drafts written\n`)
      continue
    }

    const rows = accepted.map((item) => ({
      user_id: OWNER_USER_ID,
      title: goal.title,
      focus: item.focus,
      period: 'weekly',
      target_date: weeks[item.week - 1],
      slot: PLAN_SLOT_BASE + item.week,
      parent_id: goal.id,
      // NOT `generated`. That flag means "the arithmetic owns this row and may
      // rewrite it", and reconcileGenerated would do exactly that -- replacing
      // the model's sentence with a division on the next page load.
      generated: false,
      plan_status: PLAN_STATUS.DRAFT,
      planned_at: new Date().toISOString(),
      plan_evidence: {
        cites: item.cites,
        kind: item.kind,
        reason: item.reason,
        model: answer.provider,
        planned_for: monthStart,
      },
    }))

    const { error } = await supabase
      .from('goals')
      .upsert(rows, { onConflict: 'period,target_date,slot' })

    if (error) throw error
    written += rows.length

    for (const item of accepted) {
      console.log(`   ✓ week ${item.week}: ${item.focus}`)
      console.log(`     from ${item.kind}: ${item.cites}`)
    }
    console.log(`   ${answer.provider} proposed ${accepted.length + rejected.length}, ${accepted.length} kept\n`)
  }

  console.log('─'.repeat(64))
  console.log(`✅ ${written} week(s) drafted`)
  if (written > 0) {
    console.log('   These are proposals. They appear on /goals for you to approve or')
    console.log('   discard, and nothing derives from them until you do.')
  }
}

main().catch((err) => {
  console.error('❌ Month planning failed:', err?.message || err)
  process.exit(1)
})
