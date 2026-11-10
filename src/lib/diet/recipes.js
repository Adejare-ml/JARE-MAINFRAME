/**
 * Diet: recipes, and what one portion of a pot carries.
 *
 * A recipe is its ingredients by raw weight (recipe_ingredients, migration
 * 048) divided into portions. Nutrition is computed, never stored, so
 * changing an ingredient or the portion count changes every future portion
 * at once. The sums are taken unrounded across the pot and rounded only at
 * the portion, so five portions of a pot add back up to the pot.
 *
 * Grams per portion: the cooked weight divided by the portions when the
 * pot was weighed after cooking (cooked_weight_g), otherwise the raw
 * ingredient weight divided by the portions. Beans swell to roughly twice
 * their dry weight, so the raw figure understates what is on the plate;
 * it is still the right number to log against, because the nutrition is
 * per portion, not per gram.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { toNumber, round1, MACROS } from './nutrition.js'

function lookup(foods, id) {
  if (!foods) return null
  if (foods instanceof Map) return foods.get(id) ?? null
  return foods[id] ?? null
}

/**
 * The whole pot.
 *
 * @param {Array<{food_id: string, grams: number}>} ingredients
 * @param {Map<string, object>|Record<string, object>} foods - by id, per 100 g
 * @returns {{grams: number, kcal: number, protein_g: number, carbs_g: number, fat_g: number, missing: string[]}}
 *   kcal and macros unrounded-then-rounded-once; `missing` lists food ids
 *   that are not in `foods`, so a deleted food shows rather than counting as zero.
 */
export function recipeTotals(ingredients, foods) {
  let grams = 0
  let kcal = 0
  const macros = { protein_g: 0, carbs_g: 0, fat_g: 0 }
  const missing = []
  for (const ing of ingredients || []) {
    const g = Math.max(0, toNumber(ing?.grams) ?? 0)
    const food = lookup(foods, ing?.food_id)
    if (!food) {
      if (ing?.food_id != null) missing.push(ing.food_id)
      continue
    }
    grams += g
    kcal += ((toNumber(food.kcal_per_100g) ?? 0) * g) / 100
    for (const key of MACROS) macros[key] += ((toNumber(food[key]) ?? 0) * g) / 100
  }
  return {
    grams: round1(grams),
    kcal: Math.round(kcal),
    protein_g: round1(macros.protein_g),
    carbs_g: round1(macros.carbs_g),
    fat_g: round1(macros.fat_g),
    missing,
    // Unrounded, for recipePortion to divide without compounding rounding.
    _exact: { grams, kcal, ...macros },
  }
}

/**
 * One portion.
 *
 * @param {{portions: number, cooked_weight_g?: number|null}} recipe
 * @param {Array} ingredients
 * @param {Map|object} foods
 * @returns {{grams: number, kcal: number, protein_g: number, carbs_g: number, fat_g: number,
 *   exact: object, missing: string[]}|null} null when the recipe has no portions
 */
export function recipePortion(recipe, ingredients, foods) {
  const portions = toNumber(recipe?.portions)
  if (!portions || portions <= 0) return null
  const totals = recipeTotals(ingredients, foods)
  const cooked = toNumber(recipe?.cooked_weight_g)
  const exact = {
    grams: (cooked && cooked > 0 ? cooked : totals._exact.grams) / portions,
    kcal: totals._exact.kcal / portions,
    protein_g: totals._exact.protein_g / portions,
    carbs_g: totals._exact.carbs_g / portions,
    fat_g: totals._exact.fat_g / portions,
  }
  return {
    grams: round1(exact.grams),
    kcal: Math.round(exact.kcal),
    protein_g: round1(exact.protein_g),
    carbs_g: round1(exact.carbs_g),
    fat_g: round1(exact.fat_g),
    exact,
    missing: totals.missing,
  }
}

/**
 * `portions` of a recipe as one meal item.
 *
 * @param {{id: string, name: string}} recipe
 * @param {ReturnType<typeof recipePortion>} portion
 * @param {number} [portions]
 */
export function recipeItem(recipe, portion, portions = 1) {
  const n = Math.max(0, toNumber(portions) ?? 1)
  const e = portion?.exact ?? portion ?? {}
  return {
    recipe_id: recipe?.id ?? null,
    food_id: null,
    name: recipe?.name ?? 'Recipe',
    portions: n,
    grams: round1((e.grams ?? 0) * n),
    kcal: Math.round((e.kcal ?? 0) * n),
    protein_g: round1((e.protein_g ?? 0) * n),
    carbs_g: round1((e.carbs_g ?? 0) * n),
    fat_g: round1((e.fat_g ?? 0) * n),
  }
}
