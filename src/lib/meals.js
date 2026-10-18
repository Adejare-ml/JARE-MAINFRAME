/**
 * Meals: what the model said about a photo, made safe, and the arithmetic
 * of a day's eating.
 *
 * Pure, like summary.js and refunds.js: objects in, objects out, no fetch
 * and no DOM, so the edge function can validate the model's answer with the
 * same code the browser uses and tests/meals.test.js can exercise every
 * branch without either.
 *
 * The model's JSON is treated as untrusted input. It is a language model
 * reading a photo: it can hand back an item with no name, a negative
 * calorie count, a 40,000 kcal plate, nineteen items for a bowl of rice, or
 * a field spelled slightly differently. parseMealAnalysis turns whatever
 * arrived into the one shape the UI renders and the database stores, and
 * recomputes the total itself rather than trusting the one the model added
 * up. The server does the same sum again in log_meal (migration 042), so a
 * figure on the Meals page is always the sum of the items under it.
 */

import { MEAL_TYPES } from './mealPrompt.js'

export { MEAL_TYPES }

/** Caps. One place, shared by the client, the edge function and the migration's intent. */
export const LIMITS = {
  items: 12,
  itemCalories: 3000,
  mealCalories: 8000,
  grams: 3000,
  macroGrams: 500,
  nameChars: 60,
  portionChars: 40,
  noteChars: 120,
  adviceChars: 160,
  /** The base64 body of the upload. 1.8M characters is about 1.35 MB, far above what imagePrep produces. */
  imageBase64Chars: 1_800_000,
  textChars: 500,
  hintChars: 200,
  /** Quantity multiplier on an item, from the portion stepper. */
  quantityMin: 0.25,
  quantityMax: 10,
}

export const CONFIDENCE = ['high', 'medium', 'low']
const LIGHTING = ['good', 'dark', 'bright', 'mixed']
const SHARPNESS = ['sharp', 'soft', 'blurry']

/** Where a logged meal came from. */
export const MEAL_SOURCES = ['photo', 'text', 'manual', 'repeat']

let counter = 0
/** A client-side id for a list row. Not the database id; never stored. */
export function localId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  counter += 1
  return `item-${counter}`
}

function str(value, max) {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function clampNum(value, lo, hi) {
  const n = num(value)
  if (n == null) return null
  return Math.min(hi, Math.max(lo, n))
}

function oneOf(value, allowed, fallback) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return allowed.includes(v) ? v : fallback
}

/**
 * One item in the shape the UI edits and the database stores.
 *
 * @param {object} [partial]
 * @returns {{id: string, name: string, portion: string, grams: number|null, calories: number,
 *   protein_g: number|null, carbs_g: number|null, fat_g: number|null,
 *   confidence: 'high'|'medium'|'low', note: string|null, quantity: number}}
 */
export function newItem(partial = {}) {
  return {
    id: partial.id || localId(),
    name: str(partial.name, LIMITS.nameChars),
    portion: str(partial.portion, LIMITS.portionChars),
    grams: clampNum(partial.grams, 0, LIMITS.grams),
    calories: Math.round(clampNum(partial.calories, 0, LIMITS.itemCalories) ?? 0),
    protein_g: roundTo(clampNum(partial.protein_g, 0, LIMITS.macroGrams), 1),
    carbs_g: roundTo(clampNum(partial.carbs_g, 0, LIMITS.macroGrams), 1),
    fat_g: roundTo(clampNum(partial.fat_g, 0, LIMITS.macroGrams), 1),
    confidence: oneOf(partial.confidence, CONFIDENCE, 'medium'),
    note: str(partial.note, LIMITS.noteChars) || null,
    quantity: clampNum(partial.quantity, LIMITS.quantityMin, LIMITS.quantityMax) ?? 1,
  }
}

function roundTo(n, places) {
  if (n == null) return null
  const f = Math.pow(10, places)
  return Math.round(n * f) / f
}

/**
 * Make the model's answer safe to render and store.
 *
 * Accepts the parsed object or the raw JSON string. Never throws. An answer
 * that is not an object at all is a failure; an answer that says there is no
 * food is a success with no items, because that is a real reading the owner
 * should see ("no food in this photo"), not an error to retry.
 *
 * @param {object|string} raw
 * @returns {{ok: true, analysis: {is_food: boolean, meal_type: string|null, items: Array, total_calories: number,
 *   quality: {lighting: string, sharpness: string, obstructed: boolean}, advice: string|null, dropped: number}}
 *   | {ok: false, reason: string}}
 */
export function parseMealAnalysis(raw) {
  let data = raw
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'the model did not return JSON' }
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'the model did not return a JSON object' }
  }

  const rawItems = Array.isArray(data.items) ? data.items : []
  const items = []
  let dropped = 0
  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') {
      dropped++
      continue
    }
    const item = newItem({ ...entry, quantity: 1 })
    if (!item.name) {
      dropped++
      continue
    }
    if (items.length >= LIMITS.items) {
      dropped++
      continue
    }
    items.push(item)
  }

  // "is_food": false from the model wins only when it also listed nothing;
  // a model that names three dishes and says it is not food is wrong about
  // the flag, not the dishes.
  const is_food = data.is_food === false ? items.length > 0 : true

  const q = data.quality && typeof data.quality === 'object' ? data.quality : {}

  return {
    ok: true,
    analysis: {
      is_food,
      meal_type: oneOf(data.meal_type, MEAL_TYPES, null),
      items,
      total_calories: sumCalories(items),
      quality: {
        lighting: oneOf(q.lighting, LIGHTING, 'good'),
        sharpness: oneOf(q.sharpness, SHARPNESS, 'sharp'),
        obstructed: q.obstructed === true,
      },
      advice: str(data.advice, LIMITS.adviceChars) || null,
      dropped,
    },
  }
}

/** The calories an item contributes once its quantity is applied. */
export function itemCalories(item) {
  if (!item) return 0
  const base = num(item.calories) ?? 0
  const qty = clampNum(item.quantity, LIMITS.quantityMin, LIMITS.quantityMax) ?? 1
  return Math.max(0, Math.round(base * qty))
}

/** Sum of itemCalories over a list, capped at the meal ceiling. */
export function sumCalories(items) {
  const total = (items || []).reduce((acc, item) => acc + itemCalories(item), 0)
  return Math.min(LIMITS.mealCalories, total)
}

/**
 * Macros for the meal, or null when no item carried any -- the UI then
 * shows calories alone rather than three zeros.
 *
 * @param {Array} items
 * @returns {{protein_g: number, carbs_g: number, fat_g: number}|null}
 */
export function sumMacros(items) {
  let any = false
  const out = { protein_g: 0, carbs_g: 0, fat_g: 0 }
  for (const item of items || []) {
    const qty = clampNum(item?.quantity, LIMITS.quantityMin, LIMITS.quantityMax) ?? 1
    for (const key of Object.keys(out)) {
      const v = num(item?.[key])
      if (v != null) {
        any = true
        out[key] += v * qty
      }
    }
  }
  if (!any) return null
  return { protein_g: roundTo(out.protein_g, 1), carbs_g: roundTo(out.carbs_g, 1), fat_g: roundTo(out.fat_g, 1) }
}

/**
 * Change how much of an item was eaten. The stepper calls this with the
 * new multiplier; the base figures (what the model saw) are kept so a step
 * back is exact rather than a rounding of a rounding.
 *
 * @param {object} item
 * @param {number} quantity
 */
export function withQuantity(item, quantity) {
  return { ...item, quantity: clampNum(quantity, LIMITS.quantityMin, LIMITS.quantityMax) ?? 1 }
}

/** The quantities the stepper offers, in order. */
export const QUANTITY_STEPS = [0.5, 0.75, 1, 1.5, 2, 3]

/** The next step up or down from a quantity, staying inside QUANTITY_STEPS. */
export function stepQuantity(quantity, direction) {
  const q = num(quantity) ?? 1
  if (direction > 0) return QUANTITY_STEPS.find((s) => s > q + 1e-9) ?? QUANTITY_STEPS[QUANTITY_STEPS.length - 1]
  const below = QUANTITY_STEPS.filter((s) => s < q - 1e-9)
  return below.length ? below[below.length - 1] : QUANTITY_STEPS[0]
}

/** "×1½" style label for a quantity. */
export function quantityLabel(quantity) {
  const q = num(quantity) ?? 1
  if (Math.abs(q - Math.round(q)) < 1e-9) return `×${Math.round(q)}`
  const whole = Math.floor(q)
  const frac = q - whole
  const glyph = Math.abs(frac - 0.5) < 1e-9 ? '½' : Math.abs(frac - 0.25) < 1e-9 ? '¼' : Math.abs(frac - 0.75) < 1e-9 ? '¾' : null
  if (glyph) return `×${whole > 0 ? whole : ''}${glyph}`
  return `×${q}`
}

/**
 * Which meal a clock hour most likely is. Lagos eats breakfast until late
 * morning, lunch into mid-afternoon and dinner from early evening; anything
 * between, and anything after the late news, is a snack.
 *
 * @param {number} hour - 0..23, local
 * @returns {'breakfast'|'lunch'|'dinner'|'snack'}
 */
export function mealTypeFor(hour) {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 12
  if (h >= 4 && h <= 10) return 'breakfast'
  if (h >= 11 && h <= 15) return 'lunch'
  if (h >= 18 && h <= 22) return 'dinner'
  return 'snack'
}

export const MEAL_TYPE_ICONS = { breakfast: '🌅', lunch: '☀️', dinner: '🌙', snack: '🍿' }

/**
 * A line of text for a meal's items: "Jollof rice, fried chicken ×2, Coke".
 *
 * @param {Array} items
 * @param {number} [max] - characters
 */
export function summarizeItems(items, max = 80) {
  const parts = (items || [])
    .filter((i) => i && i.name)
    .map((i) => {
      const qty = num(i.quantity) ?? 1
      return Math.abs(qty - 1) < 1e-9 ? i.name : `${i.name} ${quantityLabel(qty)}`
    })
  const text = parts.join(', ')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).replace(/,?\s+\S*$/, '')}…`
}

/**
 * The day in numbers.
 *
 * @param {Array<{calories: number, meal_type?: string}>} meals - rows for one day
 * @returns {{calories: number, count: number, byType: Record<string, number>}}
 */
export function dayTotals(meals) {
  const byType = Object.fromEntries(MEAL_TYPES.map((t) => [t, 0]))
  let calories = 0
  let count = 0
  for (const meal of meals || []) {
    const c = Math.max(0, Math.round(num(meal?.calories) ?? 0))
    calories += c
    count++
    const t = oneOf(meal?.meal_type, MEAL_TYPES, 'snack')
    byType[t] += c
  }
  return { calories, count, byType }
}

/**
 * How the day stands against the target. `ratio` is null without a target,
 * so the ring can draw an empty track rather than a false zero.
 *
 * @param {number} consumed
 * @param {number|null} target
 * @returns {{ratio: number|null, remaining: number|null, over: boolean, status: 'none'|'under'|'near'|'over'}}
 */
export function targetProgress(consumed, target) {
  const c = Math.max(0, num(consumed) ?? 0)
  const t = parseCalorieTarget(target)
  if (t == null) return { ratio: null, remaining: null, over: false, status: 'none' }
  const ratio = c / t
  const remaining = t - c
  return {
    ratio,
    remaining,
    over: remaining < 0,
    status: remaining < 0 ? 'over' : ratio >= 0.85 ? 'near' : 'under',
  }
}

/** The daily target as stored in user_settings ('calorie_target', text), or null. */
export const CALORIE_TARGET_KEY = 'calorie_target'
export const CALORIE_TARGET_MIN = 800
export const CALORIE_TARGET_MAX = 6000

export function parseCalorieTarget(value) {
  const n = num(value)
  if (n == null) return null
  const r = Math.round(n)
  if (r < CALORIE_TARGET_MIN || r > CALORIE_TARGET_MAX) return null
  return r
}

/**
 * Calories per day for the last `days` days ending today, oldest first, so
 * a week strip can draw bars with the empty days present.
 *
 * @param {Array<{eaten_on: string, calories: number}>} meals
 * @param {string} today - YYYY-MM-DD
 * @param {number} [days]
 * @returns {Array<{date: string, calories: number}>}
 */
export function daySeries(meals, today, days = 7) {
  const totals = new Map()
  for (const meal of meals || []) {
    const d = typeof meal?.eaten_on === 'string' ? meal.eaten_on.slice(0, 10) : null
    if (!d) continue
    totals.set(d, (totals.get(d) || 0) + Math.max(0, Math.round(num(meal.calories) ?? 0)))
  }
  const out = []
  const end = new Date(`${today}T00:00:00`)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end)
    d.setDate(end.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date: key, calories: totals.get(key) || 0 })
  }
  return out
}

/**
 * The items as the database stores them: no client ids, numbers normalised,
 * quantity kept so log_meal can recompute the sum.
 *
 * @param {Array} items
 */
export function itemsForStorage(items) {
  return (items || [])
    .map((i) => newItem(i))
    .filter((i) => i.name)
    .slice(0, LIMITS.items)
    .map(({ id: _id, ...rest }) => rest)
}

/**
 * Items a logged meal was made of, back in editable form for "repeat".
 *
 * @param {object} meal - a meals row
 */
export function itemsFromMeal(meal) {
  const items = Array.isArray(meal?.items) ? meal.items : []
  return items.map((i) => newItem(i)).filter((i) => i.name)
}

/**
 * Recent meals worth offering again: the most recent distinct item lists,
 * newest first, by their one-line summary.
 *
 * @param {Array} meals - rows, any order
 * @param {number} [max]
 */
export function repeatCandidates(meals, max = 6) {
  const seen = new Set()
  const out = []
  const sorted = [...(meals || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  for (const meal of sorted) {
    const items = itemsFromMeal(meal)
    if (items.length === 0) continue
    const key = summarizeItems(items, 500).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ meal, items, label: summarizeItems(items), calories: sumCalories(items) })
    if (out.length >= max) break
  }
  return out
}
