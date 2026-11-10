/**
 * Diet: merging what several models saw in one photo (Phase 3).
 *
 * The rules are the build spec's (docs/diet-module.md, section 5):
 *
 *   - match items across models by normalised name and against the foods
 *     table: an item that names a food (by name or alias) is that food,
 *     whatever words each model used; otherwise the words of its name, in
 *     any order, plurals folded, portion words ("a piece of") dropped
 *   - take the median grams of each item
 *   - recompute kcal and macros from the foods table when the item matches
 *     a food; otherwise take the median of the models' own figures
 *   - flag the item when the models' grams differ by more than 25% (largest
 *     over smallest) or only one model saw it
 *
 * With only one model answering (the others failed, or the laptop is off)
 * every item is seen by one model by definition; flagging them all would
 * teach the owner to ignore the flag, so they are left unflagged and the
 * result says single_model instead. A guessed amount (confidence under 0.5)
 * is flagged either way, as in the text parser.
 *
 * Every model's raw item is kept on the merged item under estimates[model],
 * so a later comparison can say which model came closest to what the owner
 * confirmed.
 *
 * Pure: the diet-photo edge function runs it on the first answers and
 * again when a late estimate arrives from the laptop.
 */

import { nutritionFor, toNumber, round1, sumNutrition } from './nutrition.js'
import { normaliseName } from './foods.js'
import { findFood } from './parse.js'

export const MODELS = ['claude', 'nvidia', 'ollama']
export const MODEL_LABELS = { claude: 'Claude', nvidia: 'NVIDIA', ollama: 'Ollama' }
export const DISAGREE_RATIO = 1.25
const LOW_CONFIDENCE = 0.5
const QUALITY_ORDER = ['good', 'partial', 'poor']

const FILLER = new Set(['a', 'an', 'the', 'of', 'and', 'with', 'some', 'piece', 'portion', 'serving', 'plate', 'bowl', 'cup', 'pack', 'handful'])

/** The middle value; the mean of the two middle values for an even count; null for none. */
export function median(values) {
  const v = values.map(toNumber).filter((n) => n != null).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

function words(name) {
  return normaliseName(name)
    .split(' ')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => w && !FILLER.has(w))
}

/** What makes two models' items the same item. */
export function itemKey(item, lib) {
  const food = findFood(lib, item?.food_id, item?.name, item?.local_name)
  if (food) return `food:${food.id}`
  const w = [...new Set(words(item?.name))].sort()
  return `name:${w.join(' ') || normaliseName(item?.name)}`
}

function sum(list, key) {
  return list.reduce((a, it) => a + (toNumber(it[key]) ?? 0), 0)
}

/** One model's answer, as {key: combined item}: two entries of one thing are added together. */
function byKey(answer, lib) {
  const out = new Map()
  for (const it of Array.isArray(answer?.items) ? answer.items : []) {
    if (!it || !String(it.name ?? '').trim()) continue
    const key = itemKey(it, lib)
    const prev = out.get(key)
    if (!prev) {
      out.set(key, { ...it })
      continue
    }
    const both = [prev, it]
    out.set(key, {
      ...prev,
      grams: sum(both, 'grams'),
      kcal: sum(both, 'kcal'),
      protein_g: sum(both, 'protein_g'),
      carbs_g: sum(both, 'carbs_g'),
      fat_g: sum(both, 'fat_g'),
      confidence: Math.min(toNumber(prev.confidence) ?? 1, toNumber(it.confidence) ?? 1),
      parts: [...(prev.parts || [prev]), it],
    })
  }
  return out
}

/**
 * @param {Array<{model: string, answer: object|null}>} estimates - answer is the
 *   validated food-vision JSON, or null when that model failed
 * @param {ReturnType<import('./library.js').buildLibrary>} lib
 */
export function mergeEstimates(estimates, lib) {
  const answered = (estimates || []).filter((e) => e && e.answer && MODELS.includes(e.model))
  const perModel = answered.map((e) => ({ model: e.model, items: byKey(e.answer, lib) }))
  const keys = []
  for (const m of perModel) for (const k of m.items.keys()) if (!keys.includes(k)) keys.push(k)
  const single = answered.length === 1

  const items = keys.map((key) => {
    const seen = perModel.filter((m) => m.items.has(key)).map((m) => ({ model: m.model, item: m.items.get(key) }))
    const food = key.startsWith('food:') ? lib.foodsById?.get(key.slice(5)) : null
    const grams = round1(median(seen.map((s) => s.item.grams)) ?? 0)
    const figures = food
      ? nutritionFor(food, grams)
      : {
          kcal: Math.round(median(seen.map((s) => s.item.kcal)) ?? 0),
          protein_g: round1(median(seen.map((s) => s.item.protein_g)) ?? 0),
          carbs_g: round1(median(seen.map((s) => s.item.carbs_g)) ?? 0),
          fat_g: round1(median(seen.map((s) => s.item.fat_g)) ?? 0),
        }
    const gramsSeen = seen.map((s) => toNumber(s.item.grams)).filter((g) => g != null && g > 0)
    const lo = gramsSeen.length ? Math.min(...gramsSeen) : 0
    const hi = gramsSeen.length ? Math.max(...gramsSeen) : 0
    const confidence = median(seen.map((s) => s.item.confidence))
    let flag_reason = null
    if (!single && seen.length === 1) flag_reason = `Only ${MODEL_LABELS[seen[0].model]} saw this`
    else if (!single && lo > 0 && hi / lo > DISAGREE_RATIO) flag_reason = `The models disagree on the amount: ${round1(lo)} to ${round1(hi)} g`
    else if (confidence != null && confidence < LOW_CONFIDENCE) flag_reason = 'The amount is a guess: check it'
    const best = [...seen].sort((a, b) => (toNumber(b.item.confidence) ?? 0) - (toNumber(a.item.confidence) ?? 0))[0].item
    const hiddenVotes = seen.filter((s) => s.item.hidden === true).length
    return {
      key,
      source: food ? 'food' : 'free',
      food_id: food?.id ?? null,
      recipe_id: null,
      portions: null,
      name: food ? food.name : String(best.name).replace(/\s+/g, ' ').trim().slice(0, 80),
      local_name: best.local_name ?? null,
      grams,
      ...figures,
      hidden: hiddenVotes * 2 >= seen.length && hiddenVotes > 0,
      confidence,
      flagged: flag_reason != null,
      flag_reason,
      models: seen.map((s) => s.model),
      estimates: Object.fromEntries(seen.map((s) => [s.model, s.item])),
    }
  })

  items.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.kcal - a.kcal)
  const qualities = answered.map((e) => e.answer.image_quality).filter((q) => QUALITY_ORDER.includes(q))
  return {
    items,
    totals: sumNutrition(items),
    models_answered: answered.map((e) => e.model),
    single_model: single,
    no_food: answered.length > 0 && items.length === 0 && answered.every((e) => e.answer.image_quality === 'no_food' || (e.answer.items || []).length === 0),
    image_quality: qualities.length ? QUALITY_ORDER[Math.max(...qualities.map((q) => QUALITY_ORDER.indexOf(q)))] : null,
    questions: [...new Set(answered.map((e) => String(e.answer.question ?? '').trim()).filter(Boolean))],
  }
}

/**
 * A late estimate for a meal the owner already confirmed: stored beside each
 * matching item for comparison, the owner's numbers left as they are.
 *
 * @param {Array<{id: string, food_id?: string, name: string, estimates?: object}>} stored - meal_items rows
 * @param {string} model
 * @param {object} answer - the validated food-vision JSON
 * @returns {Array<{id: string, estimates: object}>} the rows to update
 */
export function attachEstimates(stored, model, answer, lib) {
  const late = byKey(answer, lib)
  const updates = []
  for (const row of stored || []) {
    const raw = late.get(itemKey(row, lib))
    if (!raw) continue
    updates.push({ id: row.id, estimates: { ...(row.estimates || {}), [model]: raw } })
  }
  return updates
}
