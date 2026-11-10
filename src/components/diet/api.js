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
import { sumNutrition } from '../../lib/diet/nutrition'
// buildLibrary and priceItems moved to src/lib/diet/library.js in Phase 2,
// so the diet-parse edge function can use them too; re-exported here so the
// screens' imports are unchanged.
import { buildLibrary, priceItems } from '../../lib/diet/library'
import { mealVerdict } from '../../lib/diet/verdict'
import { localDay, addDays } from '../../lib/diet/totals'

export { buildLibrary, priceItems }

export const MEAL_LOG_COLUMNS = 'id, client_id, eaten_at, eaten_on, meal_slot, source, status, kcal, protein_g, carbs_g, fat_g, verdict, reason, thumbnail, saved_meal_id, photo_path, raw_text, needs_review'
export const MEAL_ITEM_COLUMNS = 'id, meal_id, food_id, recipe_id, portions, position, name, grams, kcal, protein_g, carbs_g, fat_g, hidden, confidence, flagged, flag_reason, estimates'
// Phase 3: photo meals carry photo_path and may still be status 'auto'.

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
export async function logMeal({ items, slot, source, at = new Date(), settings, todayLogs = [], savedMealId = null, rawText = null }) {
  const totals = sumNutrition(items)
  const v = mealVerdict({ settings, slot, meal: totals, earlier: todayLogs })
  // Phase 2: every item also carries what the parser said about it
  // (estimates, confidence, hidden, flagged), so the model's raw estimate is
  // stored beside the final numbers (051 stores the flags).
  const extra = (i) => ({
    hidden: i.hidden === true,
    confidence: i.confidence ?? null,
    estimates: i.estimates ?? undefined,
    flagged: i.flagged === true,
    flag_reason: i.flag_reason ?? null,
  })
  const payload = items.map((i) => {
    if (i.recipe_id) return { recipe_id: i.recipe_id, portions: i.portions ?? 1, name: i.name, ...extra(i) }
    if (i.food_id) return { food_id: i.food_id, grams: i.grams, name: i.name, ...extra(i) }
    return { name: i.name, grams: i.grams, kcal: i.kcal, protein_g: i.protein_g, carbs_g: i.carbs_g, fat_g: i.fat_g, ...extra(i) }
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
      raw_text: rawText,
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

/**
 * Send a typed or spoken note to the diet-parse edge function (Phase 2).
 * Returns the matched, priced entry to review; nothing is logged yet.
 *
 * @param {string} text
 * @returns {Promise<{ok: true, entry: object} | {ok: false, reason: string}>}
 */
export async function parseNote(text) {
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
  const { data, error } = await supabase.functions.invoke('diet-parse', { body: { text, localTime } })
  if (error) {
    // A function that was never deployed answers 404, which supabase-js
    // reports as a generic non-2xx error; say what it usually means.
    const status = error.context?.status
    return { ok: false, reason: status === 404 ? 'the diet-parse function is not deployed yet' : error.message || 'could not reach the parser' }
  }
  return data?.ok ? data : { ok: false, reason: data?.reason || 'the parser gave no answer' }
}

/**
 * Apply confirmed pantry updates through apply_pantry_updates (051),
 * idempotent on a client id minted here.
 */
export async function applyPantry(updates, rawText = null) {
  const { data, error } = await supabase.rpc('apply_pantry_updates', {
    p_client_id: crypto.randomUUID(),
    p_updates: updates,
    p_raw_text: rawText,
  })
  if (error) {
    if (/apply_pantry_updates/.test(error.message || '') && /not find|does not exist/i.test(error.message || '')) {
      throw new Error('run supabase/migrations/051_diet_pantry.sql to save pantry updates')
    }
    throw error
  }
  return data
}

// ── Phase 3: photos ──────────────────────────────────────────────────────

const PHOTO_BUCKET = 'meal-photos'

function base64ToBlob(b64, type) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

/**
 * Put a prepared photo (imagePrep's prepareImage, 1024 px) in the private
 * bucket, in the owner's own folder: <uid>/<yyyy>/<mm>/<uuid>.jpg. The
 * storage policies (052) refuse any other folder.
 */
export async function uploadPhoto(prepared) {
  const { data } = await supabase.auth.getSession()
  const uid = data?.session?.user?.id
  if (!uid) throw new Error('not signed in')
  const d = new Date()
  const path = `${uid}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage.from(PHOTO_BUCKET).upload(path, base64ToBlob(prepared.base64, 'image/jpeg'), { contentType: 'image/jpeg', upsert: false })
  if (error) throw new Error(/bucket not found/i.test(error.message) ? 'run supabase/migrations/052_diet_photos.sql to store photos' : error.message)
  return path
}

/** Ask diet-photo to read the photo. Logs it as an 'auto' meal on success. */
export async function analyzePhoto({ path, small, note = '' }) {
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
  const { data, error } = await supabase.functions.invoke('diet-photo', { body: { action: 'analyze', photo_path: path, small_image: small, note, localTime } })
  if (error) {
    const status = error.context?.status
    return { ok: false, reason: status === 404 ? 'the diet-photo function is not deployed yet' : error.message || 'could not reach the photo service' }
  }
  return data?.ok ? data : { ok: false, reason: data?.reason || 'the photo service gave no answer', models: data?.models }
}

/** "Looks right": the items as the owner left them, the meal confirmed (or edited). */
export async function confirmPhotoMeal(mealId, items, meta) {
  const payload = items.map((i) => ({
    food_id: i.food_id ?? undefined,
    recipe_id: i.recipe_id ?? undefined,
    portions: i.portions ?? undefined,
    name: i.name,
    grams: i.grams,
    kcal: i.kcal,
    protein_g: i.protein_g,
    carbs_g: i.carbs_g,
    fat_g: i.fat_g,
    hidden: i.hidden === true,
    confidence: i.confidence ?? null,
    estimates: i.estimates ?? {},
    flagged: false,
    flag_reason: null,
  }))
  const { data, error } = await supabase.rpc('diet_replace_items', { p_meal_id: mealId, p_items: payload, p_meal: { ...meta, needs_review: false } })
  if (error) throw error
  return data
}

/** Throw the meal and its photo away (a wrong photo, a meal not eaten). */
export async function discardPhotoMeal({ id, photo_path }) {
  if (id) {
    const { error } = await supabase.from('meal_logs').delete().eq('id', id)
    if (error) throw error
  }
  if (photo_path) await supabase.storage.from(PHOTO_BUCKET).remove([photo_path])
}

/**
 * A stored photo as a blob: URL for an <img>. Downloaded through the
 * authenticated Storage API rather than a signed URL, because the CSP's
 * img-src allows blob: but not the Supabase host; connect-src already
 * allows it.
 */
export async function photoUrl(path) {
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).download(path)
  if (error || !data) return null
  return URL.createObjectURL(data)
}

/** Each model's answer for a photo meal, without the answers themselves. */
export async function loadEstimates(mealId) {
  const { data } = await supabase.from('meal_estimates').select('model_key, model_id, status, reason, latency_ms, attempts').eq('meal_id', mealId)
  return data || []
}
