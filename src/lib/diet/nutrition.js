/**
 * Diet: the arithmetic of an item and a meal.
 *
 * Pure, like ../meals.js: objects in, objects out, no fetch and no DOM, so
 * the browser, the edge functions of Phases 2 and 3 and the tests all use
 * the same code. The database repeats the same sums (migration 048:
 * diet_item_nutrition and the meal_items trigger), so a meal's total on any
 * screen is always the sum of the items under it.
 *
 * Rounding is fixed in one place: kcal is a whole number per item, protein,
 * carbs and fat one decimal place. Sums are taken over the rounded item
 * figures, which is what the Daily Sheet shows row by row; summing unrounded
 * figures would let a column of numbers disagree with its own total by 0.1.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

export const MACROS = ['protein_g', 'carbs_g', 'fat_g']

/** Caps on one item, mirrored by the check constraints in migration 048. */
export const ITEM_LIMITS = {
  grams: 5000,
  kcal: 10000,
  macroGrams: 1000,
  nameChars: 80,
}

/** A finite number from a number or a numeric string ("1,500"), else null. */
export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.replace(/,/g, '').trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * One decimal place, half away from zero, with the float noise taken out
 * first: 0.1 + 0.2 is 0.30000000000000004 and 1.05 is stored as
 * 1.04999...; both should round the way a person reads them.
 */
export function round1(value) {
  const n = toNumber(value)
  if (n == null) return 0
  const scaled = Number((n * 10).toPrecision(12))
  return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / 10
}

function roundKcal(value) {
  const n = toNumber(value)
  if (n == null) return 0
  return Math.round(Number(n.toPrecision(12)))
}

function clamp(value, lo, hi) {
  const n = toNumber(value)
  if (n == null) return null
  return Math.min(hi, Math.max(lo, n))
}

const ZERO = Object.freeze({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })

/**
 * What `grams` of a food carries.
 *
 * @param {{kcal_per_100g?: number, protein_g?: number, carbs_g?: number, fat_g?: number}} food - per 100 g, as eaten
 * @param {number} grams
 * @returns {{kcal: number, protein_g: number, carbs_g: number, fat_g: number}}
 */
export function nutritionFor(food, grams) {
  const g = clamp(grams, 0, ITEM_LIMITS.grams)
  if (!food || !g) return { ...ZERO }
  const per = (key) => ((toNumber(food[key]) ?? 0) * g) / 100
  return {
    kcal: roundKcal(per('kcal_per_100g')),
    protein_g: round1(per('protein_g')),
    carbs_g: round1(per('carbs_g')),
    fat_g: round1(per('fat_g')),
  }
}

/**
 * The sum over items (or meals, or days: anything with kcal and macros).
 *
 * @param {Array<{kcal?: number, protein_g?: number, carbs_g?: number, fat_g?: number}>} items
 */
export function sumNutrition(items) {
  let kcal = 0
  const macros = { protein_g: 0, carbs_g: 0, fat_g: 0 }
  for (const item of items || []) {
    if (!item) continue
    kcal += toNumber(item.kcal) ?? 0
    for (const key of MACROS) macros[key] += toNumber(item[key]) ?? 0
  }
  return {
    kcal: roundKcal(kcal),
    protein_g: round1(macros.protein_g),
    carbs_g: round1(macros.carbs_g),
    fat_g: round1(macros.fat_g),
  }
}

function cleanName(value) {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim().slice(0, ITEM_LIMITS.nameChars)
}

/**
 * One item made safe to store. With a food behind it, the figures are
 * recomputed from the food, whatever came with the item (a model's guess,
 * a stale screen); without one, the given figures are kept, clamped.
 * Returns null for an item with no name.
 *
 * @param {object} raw - {name, grams, kcal, protein_g, carbs_g, fat_g, hidden, confidence, ...}
 * @param {object} [food] - the matched foods row, per 100 g
 */
export function cleanItem(raw, food = null) {
  const name = cleanName(raw?.name)
  if (!name) return null
  const grams = round1(clamp(raw?.grams, 0, ITEM_LIMITS.grams) ?? 0)
  const figures = food
    ? nutritionFor(food, grams)
    : {
        kcal: roundKcal(clamp(raw?.kcal, 0, ITEM_LIMITS.kcal) ?? 0),
        protein_g: round1(clamp(raw?.protein_g, 0, ITEM_LIMITS.macroGrams) ?? 0),
        carbs_g: round1(clamp(raw?.carbs_g, 0, ITEM_LIMITS.macroGrams) ?? 0),
        fat_g: round1(clamp(raw?.fat_g, 0, ITEM_LIMITS.macroGrams) ?? 0),
      }
  const confidence = clamp(raw?.confidence, 0, 1)
  return {
    food_id: food?.id ?? raw?.food_id ?? null,
    recipe_id: raw?.recipe_id ?? null,
    portions: toNumber(raw?.portions),
    name,
    grams,
    ...figures,
    hidden: raw?.hidden === true,
    confidence,
  }
}
