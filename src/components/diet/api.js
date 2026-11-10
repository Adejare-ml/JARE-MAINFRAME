/**
 * Diet: the browser's calls to Supabase, in one place.
 *
 * Kept out of src/lib/diet/ on purpose: those modules are pure and load
 * under plain Node (CI checks it), and this one imports the Supabase
 * client. The screens call these; the arithmetic they show comes from
 * src/lib/diet/, and the database repeats it (migration 048) so what is
 * stored never depends on a screen being right.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { supabase } from '../../lib/supabase'
import { recipePortion, recipeItem } from '../../lib/diet/recipes'
import { nutritionFor, sumNutrition } from '../../lib/diet/nutrition'
import { mealVerdict } from '../../lib/diet/verdict'
import { localDay, addDays } from '../../lib/diet/totals'

export const MEAL_LOG_COLUMNS = 'id, client_id, eaten_at, eaten_on, meal_slot, source, status, kcal, protein_g, carbs_g, fat_g, verdict, reason, thumbnail, saved_meal_id'
export const MEAL_ITEM_COLUMNS = 'id, meal_id, food_id, recipe_id, portions, position, name, grams, kcal, protein_g, carbs_g, fat_g, hidden'

/**
 * Everything the screens look things up in: settings, foods, recipes with
 * their ingredients, saved meals. A few hundred rows at most, so one load.
 */
export async function loadLibrary() {
  const [settings, foods, recipes, ingredients, saved] = await Promise.all([
    supabase.from('diet_settings').select('*').maybeSingle(),
    supabase.from('foods').select('*').order('name'),
    supabase.from('recipes').select('*').order('name'),
    supabase.from('recipe_ingredients').select('*').order('position'),
    supabase.from('saved_meals').select('*').order('sort_order').order('name'),
  ])
  for (const res of [settings, foods, recipes, ingredients, saved]) if (res.error) throw res.error
  return buildLibrary({
    settings: settings.data || null,
    foods: foods.data || [],
    recipes: recipes.data || [],
    ingredients: ingredients.data || [],
    saved: saved.data || [],
  })
}

/** Index the rows the way the screens read them. */
export function buildLibrary({ settings, foods, recipes, ingredients, saved }) {
  const foodsById = new Map(foods.map((f) => [f.id, f]))
  const ingredientsByRecipe = new Map()
  for (const ing of ingredients) {
    if (!ingredientsByRecipe.has(ing.recipe_id)) ingredientsByRecipe.set(ing.recipe_id, [])
    ingredientsByRecipe.get(ing.recipe_id).push(ing)
  }
  const portions = new Map()
  for (const r of recipes) portions.set(r.id, recipePortion(r, ingredientsByRecipe.get(r.id) || [], foodsById))
  const recipesById = new Map(recipes.map((r) => [r.id, r]))
  return { settings, foods, recipes, ingredients, saved, foodsById, recipesById, ingredientsByRecipe, portions }
}

/**
 * A saved meal's (or a basket's) references, priced for the screen. The
 * database prices them again on insert; this is the preview and the input
 * to the verdict.
 *
 * @param {Array<{food_id?: string, grams?: number, recipe_id?: string, portions?: number, name?: string}>} refs
 * @param {ReturnType<typeof buildLibrary>} lib
 */
export function priceItems(refs, lib) {
  return (refs || [])
    .map((ref) => {
      if (ref.recipe_id) {
        const recipe = lib.recipesById.get(ref.recipe_id)
        const portion = lib.portions.get(ref.recipe_id)
        if (!recipe || !portion) return null
        return recipeItem(recipe, portion, ref.portions ?? 1)
      }
      if (ref.food_id) {
        const food = lib.foodsById.get(ref.food_id)
        if (!food) return null
        return { food_id: food.id, recipe_id: null, name: ref.name || food.name, grams: ref.grams, ...nutritionFor(food, ref.grams) }
      }
      if (ref.name) return { food_id: null, recipe_id: null, ...ref }
      return null
    })
    .filter(Boolean)
}

/**
 * Log a meal through log_diet_meal (migration 048). The verdict is worked
 * out here, in code, because the numbers are already known: no model call
 * (the coach, Phase 4, answers only for photo and text meals).
 *
 * @param {object} args
 * @param {Array} args.items - priced items (priceItems), or refs with figures
 * @param {string} args.slot
 * @param {string} args.source - 'manual' | 'saved'
 * @param {Date} [args.at]
 * @param {object|null} args.settings
 * @param {Array} args.todayLogs - meal_logs already logged that day
 * @param {string|null} [args.savedMealId]
 */
export async function logMeal({ items, slot, source, at = new Date(), settings, todayLogs = [], savedMealId = null }) {
  const totals = sumNutrition(items)
  const v = mealVerdict({ settings, slot, meal: totals, earlier: todayLogs })
  const payload = items.map((i) => {
    if (i.recipe_id) return { recipe_id: i.recipe_id, portions: i.portions ?? 1, name: i.name }
    if (i.food_id) return { food_id: i.food_id, grams: i.grams, name: i.name }
    return { name: i.name, grams: i.grams, kcal: i.kcal, protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g, hidden: i.hidden === true }
  })
  const { data, error } = await supabase.rpc('log_diet_meal', {
    p_client_id: crypto.randomUUID(),
    p_meal: {
      eaten_at: at.toISOString(),
      eaten_on: localDay(at),
      meal_slot: slot,
      source,
      status: 'confirmed',
      verdict: v.verdict,
      reason: v.reason,
      saved_meal_id: savedMealId,
    },
    p_items: payload,
  })
  if (error) throw error
  return { ...data, verdict: v.verdict, reason: v.reason }
}

/** One day's meals with their items, oldest first. */
export async function loadDay(day) {
  const { data, error } = await supabase
    .from('meal_logs')
    .select(`${MEAL_LOG_COLUMNS}, meal_items(${MEAL_ITEM_COLUMNS})`)
    .eq('eaten_on', day)
    .order('eaten_at', { ascending: true })
  if (error) throw error
  return data || []
}

/** Daily totals for the seven days ending on `day`, for the 7-day average. */
export async function loadWeek(day) {
  const { data, error } = await supabase
    .from('diet_daily_totals')
    .select('eaten_on, meals, kcal, protein_g, carbs_g, fat_g')
    .gte('eaten_on', addDays(day, -6))
    .lte('eaten_on', day)
    .order('eaten_on')
  if (error) throw error
  return data || []
}

export async function deleteMeal(id) {
  const { error } = await supabase.from('meal_logs').delete().eq('id', id)
  if (error) throw error
}
