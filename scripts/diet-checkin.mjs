#!/usr/bin/env node
/**
 * Diet check-in: a push every morning with yesterday's numbers, a plan for
 * today, what to buy, and (in the run summary) how each photo model is doing.
 *
 * Numbers, the shopping list and the scorecard are worked out in code
 * (src/lib/diet/checkin.js). The plan is written by Claude (Haiku) and by
 * Ollama Cloud side by side: the push carries Claude's, or Ollama's when
 * Claude is unavailable, and the run summary shows both, so the two can be
 * compared day by day. With neither, the push goes out without a plan.
 *
 * Runs from .github/workflows/diet-checkin.yml. Reads with the service key,
 * scoped to the owner (scripts/lib/ownerId.mjs); writes nothing but the
 * push bookkeeping and a sync_runs row.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY,
 * VAPID_PRIVATE_KEY (+ VAPID_SUBJECT), ANTHROPIC_API_KEY and/or
 * OLLAMA_API_KEY, optional OWNER_USER_ID, DIET_CHECKIN_DRY_RUN=true,
 * DIET_SHOPPING_EXTRAS (comma-separated, e.g. "Cabbage, Oranges").
 *
 * Added after Phase 4, at the owner's request.
 */
import { appendFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { resolveOwnerUserId } from './lib/ownerId.mjs'
import { recordRun } from './lib/recordRun.mjs'
import { pushToOwner } from './lib/push.mjs'
import { askClaude, askOllama, hasClaude, hasOllama } from './lib/models.mjs'
import { localDay, addDays } from '../src/lib/diet/totals.js'
import { yesterdayNumbers, shoppingList, modelScorecard, checkinPush, checkinPlanInput } from '../src/lib/diet/checkin.js'
import { plainText } from '../src/lib/diet/coach.js'
import { MODEL_LABELS } from '../src/lib/diet/merge.js'

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DIET_CHECKIN_DRY_RUN || '')
const EXTRAS = (process.env.DIET_SHOPPING_EXTRAS || '').split(',').map((s) => s.trim()).filter(Boolean)

const PLAN_SYSTEM = `You plan one day of home-cooked Nigerian meals for one person.
Use what is in the pantry and the usual meals first. Aim to land near the calorie target and reach the protein target.
Never suggest a food the person avoids. Plain words, no dashes, no emoji.
Answer with JSON: {"plan": "Breakfast: ... Lunch: ... Dinner: ..."} in at most 45 words.`
const PLAN_SCHEMA = { type: 'object', additionalProperties: false, required: ['plan'], properties: { plan: { type: 'string' } } }

function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
}

function readPlan(reply) {
  if (!reply?.ok) return null
  try {
    return plainText(JSON.parse(reply.text).plan, 300) || null
  } catch {
    return null
  }
}

async function rows(query, label) {
  const { data, error } = await query
  if (error) {
    console.warn(`   (${label} unavailable: ${error.message})`)
    return []
  }
  return data || []
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
  const startedAt = new Date()
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const owner = await resolveOwnerUserId(supabase)
  const today = localDay(new Date())
  const yesterday = addDays(today, -1)

  const [settingsRows, logs, pantry, foods, ingredients, saved, photoMeals] = await Promise.all([
    rows(supabase.from('diet_settings').select('*').eq('user_id', owner).limit(1), 'diet_settings'),
    rows(supabase.from('meal_logs').select('kcal, protein_g, meal_slot, status').eq('user_id', owner).eq('eaten_on', yesterday), 'meal_logs'),
    rows(supabase.from('pantry_items').select('name, quantity, unit, finished, food_id, bought_at').eq('user_id', owner).order('bought_at', { ascending: false }).limit(200), 'pantry_items'),
    rows(supabase.from('foods').select('id, name').eq('user_id', owner), 'foods'),
    rows(supabase.from('recipe_ingredients').select('food_id').eq('user_id', owner), 'recipe_ingredients'),
    rows(supabase.from('saved_meals').select('name, items').eq('user_id', owner).order('sort_order'), 'saved_meals'),
    rows(supabase.from('meal_logs').select('id, status, kcal').eq('user_id', owner).eq('source', 'photo').gte('eaten_on', addDays(today, -30)), 'photo meals'),
  ])
  const settings = settingsRows[0] || {}
  const estimates = photoMeals.length
    ? await rows(supabase.from('meal_estimates').select('meal_id, model_key, status, answer').in('meal_id', photoMeals.map((m) => m.id)), 'meal_estimates')
    : []

  const y = yesterdayNumbers(logs, settings)
  const shopping = shoppingList({ foods, ingredients, saved, pantry, settings, extras: EXTRAS })
  const card = modelScorecard(estimates, photoMeals)

  const input = checkinPlanInput({ settings, yesterday: y, pantry, saved })
  const [claude, ollama] = await Promise.all([
    hasClaude() ? askClaude({ system: PLAN_SYSTEM, user: input, schema: PLAN_SCHEMA, maxTokens: 400 }) : Promise.resolve({ ok: false, reason: 'ANTHROPIC_API_KEY is not set' }),
    hasOllama() ? askOllama({ system: PLAN_SYSTEM, user: input, schema: PLAN_SCHEMA }) : Promise.resolve({ ok: false, reason: 'OLLAMA_API_KEY is not set' }),
  ])
  const claudePlan = readPlan(claude)
  const ollamaPlan = readPlan(ollama)
  const plan = claudePlan || ollamaPlan
  const push = checkinPush({ yesterday: y, plan, shopping })

  console.log(`Diet check-in for ${today} (yesterday ${yesterday})`)
  console.log(push.body)
  console.log(`Claude: ${claudePlan ? `ok (${claude.ms} ms)` : claude.reason || 'no plan'}; Ollama: ${ollamaPlan ? `ok (${ollama.ms} ms)` : ollama.reason || 'no plan'}`)

  summary(`## Diet check-in, ${today}\n`)
  summary('```\n' + push.body + '\n```\n')
  summary(`| Planner | Plan | Time |\n|---|---|---|`)
  summary(`| Claude | ${claudePlan || `_${claude.reason || 'no plan'}_`} | ${claude.ms ?? '–'} ms |`)
  summary(`| Ollama | ${ollamaPlan || `_${ollama.reason || 'no plan'}_`} | ${ollama.ms ?? '–'} ms |\n`)
  summary(`### Photo models, last 30 days (meals you checked)\n\n| Model | Meals | Average gap | Closest | Failed |\n|---|---|---|---|---|`)
  for (const c of card) summary(`| ${MODEL_LABELS[c.model]} | ${c.meals} | ${c.error_pct == null ? '–' : `${c.error_pct}%`} | ${c.closest} | ${c.failed} |`)
  summary(`\n### Shopping list\n\n${shopping.map((s) => `- ${s.name} (${s.why})`).join('\n') || '_nothing to buy_'}`)

  let outcome = { sent: 0, skipped: 'dry run' }
  if (!DRY_RUN) outcome = await pushToOwner(supabase, owner, push)
  console.log(`Push: ${JSON.stringify(outcome)}`)

  await recordRun(supabase, {
    job: 'diet-checkin',
    userId: owner,
    startedAt,
    ok: true,
    summary: `${y.meals} meals, ${y.kcal} kcal yesterday; ${shopping.length} to buy; plan from ${claudePlan ? 'Claude' : ollamaPlan ? 'Ollama' : 'nobody'}; push sent to ${outcome.sent ?? 0}${outcome.skipped ? ` (${outcome.skipped})` : ''}`,
  })
}

main().catch((err) => {
  console.error(`Diet check-in failed: ${err.message}`)
  process.exit(1)
})
