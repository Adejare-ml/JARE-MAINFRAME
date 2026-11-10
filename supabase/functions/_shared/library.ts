// The owner's Diet library (settings, foods, recipes, saved meals) read for
// an edge function, shared by diet-parse and diet-photo (Phase 3 moved it
// here from diet-parse/handler.ts). With the caller's own client, RLS
// decides what it sees; with the service role (diet-photo's worker path)
// RLS is bypassed, so userId must be given and every read is filtered by it.
import { buildLibrary } from '../../../src/lib/diet/library.js'

// deno-lint-ignore no-explicit-any
type Client = any

export async function loadLibraryWith(client: Client, userId: string | null = null) {
  // deno-lint-ignore no-explicit-any
  const own = (q: any) => (userId ? q.eq('user_id', userId) : q)
  const [settings, foods, recipes, ingredients, saved] = await Promise.all([
    own(client.from('diet_settings').select('*')).maybeSingle(),
    own(client.from('foods').select('id, name, aliases, kcal_per_100g, protein_g, carbs_g, fat_g, typical_portion_g, portion_label')).order('name'),
    own(client.from('recipes').select('*')).order('name'),
    own(client.from('recipe_ingredients').select('*')).order('position'),
    own(client.from('saved_meals').select('*')).order('name'),
  ])
  for (const res of [settings, foods, recipes, ingredients, saved]) if (res.error) throw new Error(res.error.message)
  return buildLibrary({
    settings: settings.data || null,
    foods: foods.data || [],
    recipes: recipes.data || [],
    ingredients: ingredients.data || [],
    saved: saved.data || [],
  })
}
