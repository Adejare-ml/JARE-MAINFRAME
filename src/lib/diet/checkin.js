/**
 * The daily check-in (scripts/diet-checkin.mjs, .github/workflows/diet-checkin.yml).
 *
 * Every number here is worked out in code: yesterday against the targets, the
 * shopping list from the recipes, saved meals and pantry, and how close each
 * photo model came to the meals the owner confirmed. A model (Claude, with
 * Ollama Cloud as the fallback) only writes the short plan for today, from
 * checkinPlanInput, and the push is put together by checkinPush.
 *
 * Pure and Node-loadable, like the rest of src/lib/diet.
 *
 * Added after Phase 4, at the owner's request: "a daily check-in" covering
 * yesterday's numbers, today's plan, a shopping list and a model scorecard.
 */
import { MODELS } from './merge.js'
import { round1, toNumber } from './nutrition.js'

const ON_TARGET = 0.05

/** Yesterday's meals against the targets. */
export function yesterdayNumbers(logs = [], settings = {}) {
  const kcal = Math.round(logs.reduce((s, l) => s + (toNumber(l.kcal) || 0), 0))
  const protein = round1(logs.reduce((s, l) => s + (toNumber(l.protein_g) || 0), 0))
  const target = toNumber(settings?.kcal_target)
  const proteinTarget = toNumber(settings?.protein_target_g)
  const kcalLeft = target ? target - kcal : null
  let verdict
  if (logs.length === 0) verdict = 'empty'
  else if (!target) verdict = 'no target'
  else if (Math.abs(kcalLeft) <= target * ON_TARGET) verdict = 'on target'
  else verdict = kcalLeft < 0 ? 'over' : 'under'
  return {
    meals: logs.length,
    kcal,
    protein_g: protein,
    kcal_target: target || null,
    protein_target_g: proteinTarget || null,
    kcal_left: kcalLeft,
    protein_short: proteinTarget ? round1(Math.max(0, proteinTarget - protein)) : null,
    unchecked: logs.filter((l) => l.status === 'auto').length,
    verdict,
  }
}

/** "Brown beans, dry" -> "Brown beans": the shop name, without the cooking note. */
function shopName(name) {
  return String(name || '').split(',')[0].trim()
}

function stem(word) {
  return String(word || '').toLowerCase().trim().replace(/(es|s)$/, '')
}

function avoided(name, avoid) {
  const n = String(name || '').toLowerCase()
  return avoid.some((a) => {
    const s = stem(a)
    return s.length > 2 && n.includes(s)
  })
}

/**
 * What to buy: pantry items marked finished (and not bought again since),
 * then the staples (every food in a recipe or a saved meal) that are not in
 * the pantry now, then any extras the owner always wants. Avoided foods are
 * never listed, whatever a recipe says.
 */
export function shoppingList({ foods = [], ingredients = [], saved = [], pantry = [], settings = {}, extras = [] }) {
  const avoid = Array.isArray(settings?.avoid_foods) ? settings.avoid_foods : []
  const byId = new Map(foods.map((f) => [f.id, f]))
  const inStock = pantry.filter((p) => !p.finished)
  const stockIds = new Set(inStock.map((p) => p.food_id).filter(Boolean))
  const stockNames = new Set(inStock.map((p) => stem(shopName(p.name))))
  const have = (foodId, name) => (foodId && stockIds.has(foodId)) || stockNames.has(stem(shopName(name)))

  const list = []
  const seen = new Set()
  const add = (name, why) => {
    const clean = shopName(name)
    const key = stem(clean)
    if (!clean || seen.has(key) || avoided(clean, avoid)) return
    seen.add(key)
    list.push({ name: clean, why })
  }

  for (const p of pantry) {
    if (p.finished && !have(p.food_id, p.name)) add(p.name, 'finished')
  }
  const staples = []
  for (const i of ingredients) staples.push(i.food_id)
  for (const s of saved) for (const it of Array.isArray(s.items) ? s.items : []) if (it.food_id) staples.push(it.food_id)
  for (const id of staples) {
    const food = byId.get(id)
    if (food && !have(food.id, food.name)) add(food.name, 'staple')
  }
  for (const e of extras) if (!have(null, e)) add(e, 'extra')
  return list
}

/**
 * How close each photo model came, over meals the owner has checked
 * (confirmed or edited): the average gap between the model's total and the
 * meal as saved, in percent, and how often it was the closest of the three.
 * Meals still 'auto' are left out: the merge is not the truth until checked.
 */
export function modelScorecard(estimates = [], meals = []) {
  const truth = new Map(meals.filter((m) => m.status !== 'auto' && toNumber(m.kcal) > 0).map((m) => [m.id, toNumber(m.kcal)]))
  const card = Object.fromEntries(MODELS.map((m) => [m, { model: m, meals: 0, failed: 0, gaps: [], closest: 0 }]))
  const perMeal = new Map()
  for (const e of estimates) {
    const row = card[e.model_key]
    if (!row || !truth.has(e.meal_id)) continue
    const kcal = toNumber(e.answer?.totals?.kcal)
    if (e.status !== 'ok' || kcal == null) {
      row.failed++
      continue
    }
    const gap = Math.abs(kcal - truth.get(e.meal_id)) / truth.get(e.meal_id)
    row.meals++
    row.gaps.push(gap)
    const list = perMeal.get(e.meal_id) || []
    list.push({ model: e.model_key, gap })
    perMeal.set(e.meal_id, list)
  }
  for (const list of perMeal.values()) {
    if (list.length < 2) continue
    const best = Math.min(...list.map((x) => x.gap))
    for (const x of list) if (x.gap === best) card[x.model].closest++
  }
  return Object.values(card)
    .map(({ gaps, ...r }) => ({ ...r, error_pct: gaps.length ? Math.round((gaps.reduce((s, g) => s + g, 0) / gaps.length) * 100) : null }))
    .sort((a, b) => (a.error_pct ?? Infinity) - (b.error_pct ?? Infinity))
}

/** The text the plan model gets: targets, yesterday, the pantry, the usual meals. No names. */
export function checkinPlanInput({ settings = {}, yesterday, pantry = [], saved = [] }) {
  const avoid = (settings?.avoid_foods || []).join(', ')
  const stock = pantry
    .filter((p) => !p.finished)
    .map((p) => (p.quantity != null ? `${p.name} (${p.quantity}${p.unit ? ` ${p.unit}` : ''})` : p.name))
  return [
    `Daily targets: ${settings?.kcal_target ?? 'not set'} kcal, ${settings?.protein_target_g ?? 'not set'} g protein.`,
    `Yesterday: ${yesterday?.meals ?? 0} meals, ${yesterday?.kcal ?? 0} kcal, ${yesterday?.protein_g ?? 0} g protein (${yesterday?.verdict ?? 'unknown'}).`,
    `In the pantry: ${stock.length ? stock.join(', ') : 'nothing recorded'}.`,
    `Usual meals: ${saved.map((s) => s.name).join(', ') || 'none saved'}.`,
    avoid ? `Never suggest: ${avoid}.` : '',
    settings?.substitutes ? `Use instead: ${settings.substitutes}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function yesterdayLine(y) {
  if (!y || y.meals === 0) return 'Nothing logged yesterday.'
  const head = `Yesterday: ${y.kcal.toLocaleString('en-US')} kcal, ${y.protein_g} g protein`
  const parts = []
  if (y.verdict === 'on target') parts.push('on target')
  else if (y.verdict === 'over' || y.verdict === 'under') parts.push(`${Math.abs(y.kcal_left).toLocaleString('en-US')} ${y.verdict}`)
  if (y.protein_short > 0) parts.push(`${y.protein_short} g protein short`)
  const tail = y.unchecked ? ` ${y.unchecked} photo meal${y.unchecked === 1 ? '' : 's'} to check.` : ''
  return `${head}${parts.length ? ` (${parts.join(', ')})` : ''}.${tail}`
}

/** The push: one line of numbers, the plan, the list. Kept under 400 characters. */
export function checkinPush({ yesterday, plan, shopping = [] }) {
  const lines = [yesterdayLine(yesterday)]
  if (plan) lines.push(String(plan).replace(/\s+/g, ' ').trim())
  if (shopping.length) lines.push(`Buy: ${shopping.map((s) => s.name).join(', ')}`)
  let body = lines.join('\n')
  if (body.length > 400) body = body.slice(0, 399) + '…'
  return { title: 'Diet check-in', body, url: '/diet' }
}
