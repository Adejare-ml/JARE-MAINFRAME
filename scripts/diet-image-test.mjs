#!/usr/bin/env node
/**
 * Diet image test: run the three photo models on a fixed set of Nigerian
 * food photos and report what each one saw, how far apart they were, how
 * long they took, and what the merge would have logged.
 *
 * It answers "what we have versus what we need" before the app is used in
 * earnest: which models answer at all with the keys in GitHub, whether they
 * name the dish, how much they disagree, and whether the 30-second photo
 * target is in reach. Nothing is written to the database; the library and
 * Diet settings are only read, so the prompt and the prices are the real ones.
 *
 * The photos are rows of the public Hugging Face dataset yemalin/african-food,
 * listed with the dish each one shows in scripts/fixtures/diet-images.json.
 * Their URLs are fetched fresh each run (the dataset server signs them).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY, NVIDIA_API_KEY,
 * OLLAMA_API_KEY (each optional: a model without its key is reported as
 * missing), optional OWNER_USER_ID, DIET_IMAGE_LIMIT.
 *
 * Writes the report to the run summary and to diet-image-test.json.
 *
 * Added after Phase 4, at the owner's request ("test the system with a few images").
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { resolveOwnerUserId } from './lib/ownerId.mjs'
import { askClaude, askNvidia, askOllama, hasClaude, hasNvidia, hasOllama, CLAUDE_VISION_MODEL, NVIDIA_VISION_MODEL, OLLAMA_VISION_MODEL } from './lib/models.mjs'
import { FOOD_VISION_JSON_SCHEMA, checkVision } from '../src/lib/diet/visionSchema.js'
import { FOOD_VISION_MD } from '../src/lib/diet/promptText.js'
import { fillPrompt, visionUserMessage } from '../src/lib/diet/prompts.js'
import { buildLibrary } from '../src/lib/diet/library.js'
import { mergeEstimates, MODEL_LABELS } from '../src/lib/diet/merge.js'

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
const DATASET = 'yemalin/african-food'
const FIXTURES = JSON.parse(readFileSync(new URL('./fixtures/diet-images.json', import.meta.url), 'utf8'))
const LIMIT = Math.max(1, Math.min(FIXTURES.length, Number(process.env.DIET_IMAGE_LIMIT) || FIXTURES.length))
const PHOTO_TARGET_MS = 30000

function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
}

async function loadLibrary() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { lib: buildLibrary({}), note: 'no database: prompt without settings, nothing priced from foods' }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  const owner = await resolveOwnerUserId(supabase)
  const q = (t, sel = '*') => supabase.from(t).select(sel).eq('user_id', owner)
  const [settings, foods, recipes, ingredients, saved] = await Promise.all([q('diet_settings').maybeSingle(), q('foods'), q('recipes'), q('recipe_ingredients'), q('saved_meals')])
  for (const r of [settings, foods, recipes, ingredients, saved]) if (r.error) throw new Error(r.error.message)
  return {
    lib: buildLibrary({ settings: settings.data, foods: foods.data, recipes: recipes.data, ingredients: ingredients.data, saved: saved.data }),
    note: `${foods.data.length} foods, settings ${settings.data ? 'found' : 'missing'}`,
  }
}

async function loadPhoto(row) {
  const res = await fetch(`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&offset=${row}&length=1`)
  if (!res.ok) throw new Error(`dataset row ${row}: ${res.status}`)
  const src = (await res.json()).rows?.[0]?.row?.image?.src
  if (!src) throw new Error(`dataset row ${row}: no image`)
  const img = await fetch(src)
  if (!img.ok) throw new Error(`photo ${row}: ${img.status}`)
  const bytes = Buffer.from(await img.arrayBuffer())
  if (bytes.length > 3.5 * 1024 * 1024) throw new Error(`photo ${row} is ${(bytes.length / 1e6).toFixed(1)} MB, over the app's limit`)
  return { base64: bytes.toString('base64'), mime: img.headers.get('content-type') || 'image/jpeg', kb: Math.round(bytes.length / 1024) }
}

async function runModel(name, call) {
  for (const attempt of [1, 2]) {
    const reply = await call()
    if (!reply.ok) {
      if (attempt === 1 && reply.status === 'error') continue
      return { model: name, status: reply.status || 'error', reason: reply.reason, ms: reply.ms, answer: null }
    }
    const checked = checkVision(reply.text)
    if (checked.ok) return { model: name, status: 'ok', ms: reply.ms, answer: checked.answer, attempts: attempt }
    if (attempt === 2) return { model: name, status: 'invalid', reason: checked.reason, ms: reply.ms, answer: null }
  }
}

const sawDish = (answer, words) => {
  const text = (answer?.items || []).map((i) => `${i.name} ${i.local_name || ''}`).join(' ').toLowerCase()
  return words.some((w) => text.includes(w.toLowerCase()))
}

async function main() {
  const { lib, note } = await loadLibrary()
  const system = fillPrompt(FOOD_VISION_MD, lib.settings)
  const models = [
    ['claude', hasClaude(), CLAUDE_VISION_MODEL()],
    ['nvidia', hasNvidia(), NVIDIA_VISION_MODEL()],
    ['ollama', hasOllama(), OLLAMA_VISION_MODEL()],
  ]
  console.log(`Library: ${note}`)
  console.log(`Models: ${models.map(([m, on, id]) => `${m}=${on ? id : 'NO KEY'}`).join(', ')}`)

  const results = []
  for (const fx of FIXTURES.slice(0, LIMIT)) {
    let photo
    try {
      photo = await loadPhoto(fx.row)
    } catch (err) {
      console.warn(`${fx.dish}: ${err.message}`)
      results.push({ ...fx, error: err.message })
      continue
    }
    const user = visionUserMessage({ note: null, localTime: '13:00' })
    const started = Date.now()
    const runs = await Promise.all(
      models.map(([m, on, id]) => {
        if (!on) return { model: m, status: 'skipped', reason: 'no key in GitHub secrets', answer: null }
        if (m === 'claude') return runModel(m, () => askClaude({ model: id, system, user, schema: FOOD_VISION_JSON_SCHEMA, image: photo, maxTokens: 4000 }))
        if (m === 'nvidia') return runModel(m, () => askNvidia({ model: id, system, user, image: photo }))
        return runModel(m, () => askOllama({ model: id, system, user, image: photo, schema: FOOD_VISION_JSON_SCHEMA, timeoutMs: 120000 }))
      }),
    )
    const wallMs = Date.now() - started
    // The app's analyze step waits for Claude and NVIDIA only; Ollama's comes later.
    const appMs = Math.max(0, ...runs.filter((r) => r.model !== 'ollama' && r.ms).map((r) => r.ms))
    const merged = mergeEstimates(runs.filter((r) => r.model !== 'ollama').map((r) => ({ model: r.model, answer: r.answer })), lib)
    const mergedAll = mergeEstimates(runs.map((r) => ({ model: r.model, answer: r.answer })), lib)
    results.push({ ...fx, kb: photo.kb, wallMs, appMs, runs, merged: { kcal: merged.totals.kcal, protein_g: merged.totals.protein_g, flagged: merged.items.filter((i) => i.flagged).length, items: merged.items.map((i) => `${i.name} ${i.grams} g`) }, mergedAll: { kcal: mergedAll.totals.kcal } })
    console.log(`${fx.dish}: app ${appMs} ms, merged ${merged.totals.kcal} kcal; ${runs.map((r) => `${r.model} ${r.status}${r.answer ? ` ${Math.round(r.answer.totals.kcal)} kcal` : ''}`).join(', ')}`)
  }

  writeFileSync('diet-image-test.json', JSON.stringify({ when: new Date().toISOString(), models: models.map(([m, on, id]) => ({ model: m, configured: on, id })), results }, null, 2))

  summary(`## Diet image test\n\nLibrary: ${note}. Models: ${models.map(([m, on, id]) => `${MODEL_LABELS[m]} ${on ? `\`${id}\`` : '**no key**'}`).join(', ')}.\n`)
  summary('| Photo | ' + models.map(([m]) => MODEL_LABELS[m]).join(' | ') + ' | Merged (Claude+NVIDIA) | Flagged | App time |')
  summary('|---|' + models.map(() => '---').join('|') + '|---|---|---|')
  for (const r of results) {
    if (r.error) {
      summary(`| ${r.dish} | ${models.map(() => '–').join(' | ')} | _${r.error}_ | | |`)
      continue
    }
    const cells = r.runs.map((x) => (x.answer ? `${Math.round(x.answer.totals.kcal)} kcal${sawDish(x.answer, r.words) ? ' ✓' : ' ✗ dish'} (${(x.ms / 1000).toFixed(1)} s)` : `_${x.status}: ${(x.reason || '').slice(0, 60)}_`))
    summary(`| ${r.dish} | ${cells.join(' | ')} | ${r.merged.kcal} kcal: ${r.merged.items.join(', ')} | ${r.merged.flagged} | ${(r.appMs / 1000).toFixed(1)} s${r.appMs > PHOTO_TARGET_MS ? ' ⚠' : ''} |`)
  }
  const ok = (m) => results.filter((r) => r.runs?.find((x) => x.model === m)?.status === 'ok').length
  const named = (m) => results.filter((r) => { const x = r.runs?.find((y) => y.model === m); return x?.answer && sawDish(x.answer, r.words) }).length
  const tested = results.filter((r) => !r.error).length
  summary(`\n### What we have\n`)
  for (const [m, on] of models) summary(`- ${MODEL_LABELS[m]}: ${on ? `answered ${ok(m)}/${tested}, named the dish ${named(m)}/${tested}` : 'not configured'}`)
  const slow = results.filter((r) => r.appMs > PHOTO_TARGET_MS).length
  summary(`- Photo to answer under 30 s (Claude and NVIDIA, in parallel): ${tested - slow}/${tested}`)
  summary(`\n✓ = the model named the dish the photo shows; ✗ dish = it did not. Grams and calories have no ground truth here: compare the models with each other, and with your own meals once you log them.`)

  if (tested === 0) throw new Error('no photo could be loaded')
}

main().catch((err) => {
  console.error(`Image test failed: ${err.message}`)
  process.exit(1)
})
