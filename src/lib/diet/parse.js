/**
 * Diet: the text parser's answer, turned into an entry to review.
 *
 * The diet-parse edge function asks claude-haiku-5-5 to read a typed or
 * spoken note (prompts/text-parse.md) and validates the JSON with zod. This
 * module does what the model must not be trusted with: it checks every id
 * the model chose against the owner's own foods, recipes and saved meals,
 * prices matched items from the foods table (whatever figures came back),
 * expands a saved meal into its items, clamps the rest, and flags what the
 * owner should look at. It writes nothing; the review screen does, after
 * one tap.
 *
 * Pure, so the edge function and the browser run the same code and the
 * tests exercise it without a model (tests/diet-parse.test.js).
 *
 * Added for the Diet module, Phase 2 (docs/diet-module.md).
 */

import { cleanItem, nutritionFor, sumNutrition, toNumber, round1 } from './nutrition.js'
import { recipeItem } from './recipes.js'
import { normaliseName } from './foods.js'
import { priceItems } from './library.js'
import { SLOTS } from './totals.js'

export const PARSE_LIMITS = { textChars: 500, items: 30, pantry: 20 }
export const PANTRY_ACTIONS = ['bought', 'finished', 'used']
const INTENTS = ['meal', 'pantry', 'both', 'unclear']
const LOW_CONFIDENCE = 0.5

function sameName(a, b) {
  const x = normaliseName(a)
  const y = normaliseName(b)
  if (!x || !y) return false
  return x === y || x.replace(/s$/, '') === y.replace(/s$/, '')
}

function findFood(lib, id, ...names) {
  if (id && lib.foodsById?.has(id)) return lib.foodsById.get(id)
  for (const name of names) {
    if (!name) continue
    const hit = (lib.foods || []).find((f) => sameName(f.name, name) || (f.aliases || []).some((a) => sameName(a, name)))
    if (hit) return hit
  }
  return null
}

function findRecipe(lib, id, ...names) {
  if (id && lib.recipesById?.has(id)) return lib.recipesById.get(id)
  return (lib.recipes || []).find((r) => names.some((n) => n && sameName(r.name, n))) ?? null
}

function findSaved(lib, id, ...names) {
  const saved = lib.saved || []
  return saved.find((s) => s.id === id) ?? saved.find((s) => names.some((n) => n && sameName(s.name, n))) ?? null
}

function flagFor(raw, source) {
  if (source === 'free') return 'Not in your foods list: check the amount and the figures'
  const c = toNumber(raw?.confidence)
  if (c != null && c < LOW_CONFIDENCE) return 'The amount is a guess: check it'
  return null
}

function finish(item, raw, source, extra = {}) {
  const flag_reason = flagFor(raw, source)
  return {
    source,
    saved_meal_id: null,
    ...item,
    hidden: raw?.hidden === true,
    confidence: toNumber(raw?.confidence),
    flagged: flag_reason != null,
    flag_reason,
    estimates: { claude_text: raw },
    ...extra,
  }
}

/**
 * @param {object|null} parsed - the validated model answer
 * @param {ReturnType<import('./library.js').buildLibrary>} lib
 * @returns {{intent: string, meal_slot: string|null, question: string|null, saved_meal_id: string|null,
 *   items: Array, pantry: Array, totals: {kcal: number, protein_g: number, carbs_g: number, fat_g: number}}}
 */
export function matchParsed(parsed, lib) {
  const p = parsed && typeof parsed === 'object' ? parsed : {}
  const items = []
  let savedMealId = null
  for (const raw of (Array.isArray(p.items) ? p.items : []).slice(0, PARSE_LIMITS.items)) {
    if (!raw || typeof raw !== 'object' || !String(raw.name ?? '').trim()) continue
    const saved = findSaved(lib, raw.saved_meal_id, raw.name, raw.local_name)
    if (saved && (raw.saved_meal_id || !raw.food_id)) {
      const times = Math.max(0.25, toNumber(raw.portions) ?? 1)
      for (const priced of priceItems(saved.items, lib)) {
        const scaled = times === 1 ? priced : scaleItem({ ...priced, source: priced.recipe_id ? 'recipe' : 'food' }, priced.grams * times, lib)
        items.push(finish(scaled, raw, 'saved', { saved_meal_id: saved.id }))
      }
      savedMealId = savedMealId ?? saved.id
      continue
    }
    const recipe = findRecipe(lib, raw.recipe_id, raw.name, raw.local_name)
    const portion = recipe ? lib.portions?.get(recipe.id) : null
    if (recipe && portion && (raw.recipe_id || !raw.food_id)) {
      items.push(finish(recipeItem(recipe, portion, Math.min(20, Math.max(0.25, toNumber(raw.portions) ?? 1))), raw, 'recipe'))
      continue
    }
    const food = findFood(lib, raw.food_id, raw.name, raw.local_name)
    if (food) {
      const cleaned = cleanItem({ ...raw, name: food.name, food_id: food.id, recipe_id: null, portions: null }, food)
      items.push(finish(cleaned, raw, 'food'))
      continue
    }
    const free = cleanItem({ ...raw, food_id: null, recipe_id: null, portions: null })
    if (free) items.push(finish(free, raw, 'free'))
  }
  // Flagged first: those are the ones to look at before "Looks right".
  // Keys by position, after sorting: stable for the review list and not
  // random (.jules/sentinel.md: no Math.random for ids).
  items.sort((a, b) => Number(b.flagged) - Number(a.flagged))
  items.forEach((it, i) => {
    it.key = `item-${i}`
  })
  return {
    intent: INTENTS.includes(p.intent) ? p.intent : 'unclear',
    meal_slot: SLOTS.includes(p.meal_slot) ? p.meal_slot : null,
    question: String(p.question ?? '').trim() || null,
    saved_meal_id: savedMealId,
    items,
    pantry: pantryUpdates(p, lib),
    totals: sumNutrition(items),
  }
}

/** Naira from a number or text: "₦1,500", "1.5k", "N 2k". Null if it is not an amount. */
export function parseNaira(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
  const m = String(value ?? '').toLowerCase().replace(/[₦,\s]|^n|naira/g, '').match(/^(\d+(?:\.\d+)?)(k)?$/)
  if (!m) return null
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1))
}

/** The pantry part of the answer, checked: a known action, a name, numbers that are numbers. */
export function pantryUpdates(parsed, lib) {
  const list = Array.isArray(parsed?.pantry) ? parsed.pantry : []
  const out = []
  for (const u of list.slice(0, PARSE_LIMITS.pantry)) {
    const name = String(u?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!name || !PANTRY_ACTIONS.includes(u?.action)) continue
    const quantity = toNumber(u.quantity)
    out.push({
      action: u.action,
      name,
      food_id: findFood(lib, u.food_id, name)?.id ?? null,
      quantity: quantity != null && quantity > 0 ? round1(quantity) : null,
      unit: String(u.unit ?? '').trim().slice(0, 20) || null,
      cost_naira: parseNaira(u.cost_naira),
    })
  }
  return out
}

/**
 * The same item at a new weight, for the review screen's steppers. A food
 * is re-priced from its row; a recipe item changes portions; a free item
 * scales in proportion.
 */
export function scaleItem(item, grams, lib) {
  const g = Math.max(0, Math.min(5000, toNumber(grams) ?? 0))
  if (item.recipe_id) {
    const recipe = lib.recipesById?.get(item.recipe_id)
    const portion = lib.portions?.get(item.recipe_id)
    if (recipe && portion && portion.exact?.grams > 0) {
      const portions = Math.max(0.05, Math.min(20, round1(g / portion.exact.grams)))
      return { ...item, ...recipeItem(recipe, portion, portions), name: item.name }
    }
  }
  if (item.food_id) {
    const food = lib.foodsById?.get(item.food_id)
    if (food) return { ...item, grams: round1(g), ...nutritionFor(food, g) }
  }
  const base = toNumber(item.grams)
  const k = base ? g / base : 1
  return {
    ...item,
    grams: round1(g),
    kcal: Math.round((toNumber(item.kcal) ?? 0) * k),
    protein_g: round1((toNumber(item.protein_g) ?? 0) * k),
    carbs_g: round1((toNumber(item.carbs_g) ?? 0) * k),
    fat_g: round1((toNumber(item.fat_g) ?? 0) * k),
  }
}
