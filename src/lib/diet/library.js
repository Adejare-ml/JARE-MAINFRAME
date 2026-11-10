/**
 * Diet: the owner's library (settings, foods, recipes, saved meals) indexed
 * the way the screens and the diet-parse edge function read it, and a list
 * of references (a saved meal, a basket) priced against it.
 *
 * Pure. Moved here from src/components/diet/api.js in Phase 2 so the edge
 * function, which cannot import the browser's Supabase client, prices items
 * with the same code the screens use.
 *
 * Added for the Diet module, Phase 2 (docs/diet-module.md).
 */

import { recipePortion, recipeItem } from './recipes.js'
import { nutritionFor } from './nutrition.js'

/** Index the rows the way the screens read them. */
export function buildLibrary({ settings = null, foods = [], recipes = [], ingredients = [], saved = [] }) {
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

