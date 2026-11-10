// The diet-photo request handler (Diet module, Phase 3), with its outside
// world passed in so handler_test.ts can run every branch without a network.
//
// Three actions, one function:
//
//   analyze   (the owner, from the app, with their JWT)
//     The photo is already in the private meal-photos bucket. Claude and
//     NVIDIA read it in parallel, each with one retry on an answer that does
//     not validate; their answers are merged (src/lib/diet/merge.js) and the
//     meal is logged with status 'auto' for the owner to check. Each model's
//     answer, or the reason it has none, goes into meal_estimates. Ollama is
//     not waited for: the laptop may be off, and a log must never wait on it.
//
//   pending   (the laptop worker, with the worker token)
//     Up to three recent photo meals with no Ollama estimate yet, each with a
//     signed URL for the photo (15 minutes), the filled prompt and the model
//     to run. The worker needs nothing else and opens no ports.
//
//   estimate  (the laptop worker, with the worker token)
//     Stores the Ollama answer (validated again here) and re-merges: a meal
//     still 'auto' gets the three-model merge; a meal the owner already
//     confirmed or edited keeps its numbers and only gains the estimate
//     beside each item, for comparison.
//
// The worker token (DIET_WORKER_TOKEN) is a secret of its own, not the
// service role key: what sits on the laptop can list photo meals and add
// estimates, and nothing else. This narrows docs/diet-module.md section 7,
// point 10, which had proposed the service role key for the worker.
//
// Failures after the auth checks are HTTP 200 with {ok: false, reason}, as in
// analyze-meal and diet-parse.
import { FOOD_VISION_MD } from '../../../src/lib/diet/promptText.js'
import { fillPrompt, visionUserMessage } from '../../../src/lib/diet/prompts.js'
import { mergeEstimates, attachEstimates } from '../../../src/lib/diet/merge.js'
import { slotForHour } from '../../../src/lib/diet/totals.js'
import { loadLibraryWith } from '../_shared/library.ts'
import { FoodVision, type FoodVisionT } from './schema.ts'

export const SERVICE = 'diet-photo'
export const DEFAULTS = {
  claude: 'claude-sonnet-5-5',
  nvidia: 'meta/llama-3.2-90b-vision-instruct',
  ollama: 'qwen3-vl:8b',
}
const PENDING_WINDOW_HOURS = 48
const PENDING_BATCH = 3
const SIGNED_URL_SECONDS = 900

export type ModelReply = { answer: unknown; stopReason?: string | null }
export type VisionCall = (args: { model: string; system: string; user: string; image: string; mime: string }) => Promise<ModelReply>

// deno-lint-ignore no-explicit-any
type Client = any

export type Deps = {
  env: (name: string) => string | undefined
  userClient: (authHeader: string) => Client
  adminClient: () => Client
  callClaude: VisionCall
  callNvidia: VisionCall
  now?: () => Date
}

export type Estimate = {
  model_key: 'claude' | 'nvidia' | 'ollama'
  model_id: string
  status: 'ok' | 'invalid' | 'error' | 'refused' | 'skipped'
  reason: string | null
  answer: FoodVisionT | null
  latency_ms: number
  attempts: number
}

const LAGOS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const PATH = /^([0-9a-f-]{36})\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(jpg|webp)$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Equal-time string comparison, so the token cannot be guessed a character at a time. */
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function toBase64(bytes: Uint8Array) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** One model, one photo: one retry on an answer that does not validate; a refusal is not retried. */
export async function runModel(key: Estimate['model_key'], model: string, call: () => Promise<ModelReply>): Promise<Estimate> {
  const started = Date.now()
  const reasons: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await call()
      if (reply.stopReason === 'refusal') {
        return { model_key: key, model_id: model, status: 'refused', reason: 'the model declined', answer: null, latency_ms: Date.now() - started, attempts: attempt }
      }
      const checked = FoodVision.safeParse(reply.answer)
      if (checked.success) {
        return { model_key: key, model_id: model, status: 'ok', reason: null, answer: checked.data, latency_ms: Date.now() - started, attempts: attempt }
      }
      reasons.push(`attempt ${attempt}: the answer did not match the schema (${checked.error.issues[0]?.path.join('.') || 'root'}: ${checked.error.issues[0]?.message})`)
    } catch (err) {
      const e = err as Error
      reasons.push(`attempt ${attempt}: ${e?.name === 'AbortError' ? 'timed out' : e?.message ?? String(err)}`.slice(0, 200))
      // A network or API failure is reported, not retried here: the SDK and
      // the fetch wrapper already retried what was worth retrying.
      return { model_key: key, model_id: model, status: 'error', reason: reasons.join('; '), answer: null, latency_ms: Date.now() - started, attempts: attempt }
    }
  }
  return { model_key: key, model_id: model, status: 'invalid', reason: reasons.join('; '), answer: null, latency_ms: Date.now() - started, attempts: 2 }
}

/** The merged items in the shape log_diet_meal and diet_replace_items take. */
function storageItems(items: Array<Record<string, unknown>>) {
  return items.map((i) => ({
    food_id: i.food_id ?? undefined,
    name: i.name,
    grams: i.grams,
    kcal: i.kcal,
    protein_g: i.protein_g,
    carbs_g: i.carbs_g,
    fat_g: i.fat_g,
    hidden: i.hidden === true,
    confidence: i.confidence ?? null,
    flagged: i.flagged === true,
    flag_reason: i.flag_reason ?? null,
    estimates: i.estimates ?? {},
  }))
}

const summary = (e: Estimate) => ({ model_key: e.model_key, model_id: e.model_id, status: e.status, reason: e.reason, latency_ms: e.latency_ms, attempts: e.attempts, items: e.answer?.items.length ?? 0 })

export function makeHandler(deps: Deps) {
  const origin = deps.env('ALLOWED_ORIGIN') || 'https://jare-mainframe.pages.dev'
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-token',
    Vary: 'Origin',
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  const now = deps.now ?? (() => new Date())
  const keys = { anthropic: Boolean(deps.env('ANTHROPIC_API_KEY')), nvidia: Boolean(deps.env('NVIDIA_API_KEY')), worker: Boolean(deps.env('DIET_WORKER_TOKEN')) }

  async function pinnedOwner(): Promise<string | null> {
    const { data } = await deps.adminClient().from('jare_owner').select('user_id').limit(1).maybeSingle()
    return data?.user_id ?? null
  }

  // ── analyze ──────────────────────────────────────────────────────────────
  async function analyze(req: Request, body: Record<string, unknown>) {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ ok: false, reason: 'missing Authorization header' }, 401)
    const user = deps.userClient(authHeader)
    const { data: userData, error: userError } = await user.auth.getUser()
    if (userError || !userData?.user) return json({ ok: false, reason: 'not signed in' }, 401)
    const owner = await pinnedOwner()
    if (!owner || owner !== userData.user.id) return json({ ok: false, reason: 'this service answers its owner only' }, 403)
    if (!keys.anthropic && !keys.nvidia) return json({ ok: false, reason: 'the photo service is not set up yet (no ANTHROPIC_API_KEY or NVIDIA_API_KEY secret)' })

    const path = typeof body.photo_path === 'string' ? body.photo_path : ''
    const m = PATH.exec(path)
    if (!m || m[1] !== owner) return json({ ok: false, reason: 'the photo path is not one of yours' })
    const small = typeof body.small_image === 'string' ? body.small_image.replace(/\s+/g, '') : ''
    if (small && (small.length > 600_000 || !BASE64.test(small))) return json({ ok: false, reason: 'the small photo is not base64 or too large' })
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : ''
    const localTime = typeof body.localTime === 'string' && /^\d{2}:\d{2}$/.test(body.localTime) ? body.localTime : LAGOS.format(now())

    const { data: file, error: dlError } = await user.storage.from('meal-photos').download(path)
    if (dlError || !file) return json({ ok: false, reason: `could not read the photo from storage: ${dlError?.message ?? 'not found'}` })
    const image = toBase64(new Uint8Array(await file.arrayBuffer()))
    const mime = path.endsWith('.webp') ? 'image/webp' : 'image/jpeg'

    let lib
    try {
      lib = await loadLibraryWith(user)
    } catch (err) {
      return json({ ok: false, reason: `could not read your foods: ${(err as Error).message}` })
    }
    const system = fillPrompt(FOOD_VISION_MD, lib.settings)
    const userText = visionUserMessage({ note, localTime })
    const claudeModel = deps.env('DIET_PHOTO_CLAUDE_MODEL') || DEFAULTS.claude
    // buildLibrary is plain JS; its settings default (null) types it as never.
    const settings = lib.settings as { nvidia_vision_model?: string | null } | null
    const nvidiaModel = settings?.nvidia_vision_model || deps.env('NVIDIA_VISION_MODEL') || DEFAULTS.nvidia

    const skipped = (key: Estimate['model_key'], model: string, reason: string): Estimate => ({ model_key: key, model_id: model, status: 'skipped', reason, answer: null, latency_ms: 0, attempts: 0 })
    const estimates = await Promise.all([
      keys.anthropic ? runModel('claude', claudeModel, () => deps.callClaude({ model: claudeModel, system, user: userText, image, mime })) : Promise.resolve(skipped('claude', claudeModel, 'no ANTHROPIC_API_KEY')),
      keys.nvidia
        ? runModel('nvidia', nvidiaModel, () => deps.callNvidia({ model: nvidiaModel, system, user: userText, image: small || image, mime: small ? 'image/jpeg' : mime }))
        : Promise.resolve(skipped('nvidia', nvidiaModel, 'no NVIDIA_API_KEY')),
    ])
    const merged = mergeEstimates(estimates.map((e) => ({ model: e.model_key, answer: e.answer })), lib)

    if (merged.models_answered.length === 0) {
      console.warn(`${SERVICE}: no model answered:`, estimates.map((e) => `${e.model_key}: ${e.reason}`).join(' | '))
      return json({ ok: false, reason: `no model could read the photo (${estimates.map((e) => `${e.model_key}: ${e.reason}`).join('; ')})`.slice(0, 400), models: estimates.map(summary) })
    }
    if (merged.no_food) return json({ ok: true, no_food: true, entry: merged, models: estimates.map(summary) })

    const [hh] = localTime.split(':').map(Number)
    const { data: logged, error: logError } = await user.rpc('log_diet_meal', {
      p_client_id: `photo-${path.split('/').pop()}`,
      p_meal: { source: 'photo', status: 'auto', meal_slot: slotForHour(hh), raw_text: note || null },
      p_items: storageItems(merged.items),
    })
    if (logError) return json({ ok: false, reason: `could not save the meal: ${logError.message}` })
    const mealId = logged.id
    const { error: pathError } = await user.from('meal_logs').update({ photo_path: path }).eq('id', mealId)
    if (pathError) console.warn(`${SERVICE}: photo_path not saved:`, pathError.message)
    const { error: estError } = await user.from('meal_estimates').upsert(
      estimates.map((e) => ({ meal_id: mealId, model_key: e.model_key, model_id: e.model_id, status: e.status, reason: e.reason, answer: e.answer, latency_ms: e.latency_ms, attempts: e.attempts })),
      { onConflict: 'meal_id,model_key' },
    )
    if (estError) console.warn(`${SERVICE}: estimates not saved:`, estError.message)

    return json({ ok: true, meal_id: mealId, entry: merged, models: estimates.map(summary) })
  }

  // ── worker: pending and estimate ─────────────────────────────────────────
  function workerAllowed(req: Request) {
    const expected = deps.env('DIET_WORKER_TOKEN') || ''
    return sameSecret(req.headers.get('x-worker-token') || '', expected)
  }

  async function pending() {
    const admin = deps.adminClient()
    const owner = await pinnedOwner()
    if (!owner) return json({ ok: false, reason: 'no pinned owner' })
    const since = new Date(now().getTime() - PENDING_WINDOW_HOURS * 3600_000).toISOString()
    const { data: meals, error } = await admin
      .from('meal_logs')
      .select('id, photo_path, raw_text, eaten_at, status')
      .eq('user_id', owner)
      .eq('source', 'photo')
      .not('photo_path', 'is', null)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) return json({ ok: false, reason: error.message })
    const ids = (meals || []).map((m: { id: string }) => m.id)
    const done = new Set<string>()
    if (ids.length) {
      const { data: rows } = await admin.from('meal_estimates').select('meal_id').in('meal_id', ids).eq('model_key', 'ollama')
      for (const r of rows || []) done.add(r.meal_id)
    }
    const todo = (meals || []).filter((m: { id: string }) => !done.has(m.id)).slice(0, PENDING_BATCH)
    if (todo.length === 0) return json({ ok: true, jobs: [] })
    const { data: settings } = await admin.from('diet_settings').select('*').eq('user_id', owner).maybeSingle()
    const system = fillPrompt(FOOD_VISION_MD, settings)
    const model = settings?.ollama_vision_model || DEFAULTS.ollama
    const jobs = []
    for (const meal of todo) {
      const { data: signed, error: signError } = await admin.storage.from('meal-photos').createSignedUrl(meal.photo_path, SIGNED_URL_SECONDS)
      if (signError || !signed?.signedUrl) continue
      jobs.push({ meal_id: meal.id, image_url: signed.signedUrl, system, user: visionUserMessage({ note: meal.raw_text, localTime: LAGOS.format(new Date(meal.eaten_at)) }), model })
    }
    return json({ ok: true, jobs })
  }

  async function estimate(body: Record<string, unknown>) {
    const admin = deps.adminClient()
    const owner = await pinnedOwner()
    const mealId = typeof body.meal_id === 'string' ? body.meal_id : ''
    const { data: meal } = await admin.from('meal_logs').select('id, user_id, status').eq('id', mealId).eq('user_id', owner).maybeSingle()
    if (!meal) return json({ ok: false, reason: 'no such photo meal' })

    const statuses = ['ok', 'invalid', 'error', 'refused', 'skipped']
    let status = statuses.includes(body.status as string) ? (body.status as Estimate['status']) : 'error'
    let reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null
    let answer: FoodVisionT | null = null
    if (status === 'ok') {
      // Checked by pydantic on the laptop, and again here: the database only
      // ever holds answers in this shape.
      const checked = FoodVision.safeParse(body.answer)
      if (checked.success) answer = checked.data
      else {
        status = 'invalid'
        reason = `rejected by the server schema: ${checked.error.issues[0]?.path.join('.')}: ${checked.error.issues[0]?.message}`
      }
    }
    const row = {
      user_id: meal.user_id,
      meal_id: meal.id,
      model_key: 'ollama',
      model_id: typeof body.model_id === 'string' ? body.model_id.slice(0, 80) : DEFAULTS.ollama,
      status,
      reason,
      answer,
      latency_ms: Number.isFinite(body.latency_ms) ? Math.round(body.latency_ms as number) : null,
      attempts: Number.isInteger(body.attempts) ? Math.min(5, Math.max(0, body.attempts as number)) : 1,
    }
    const { error: upError } = await admin.from('meal_estimates').upsert(row, { onConflict: 'meal_id,model_key' })
    if (upError) return json({ ok: false, reason: upError.message })
    if (!answer) return json({ ok: true, stored: status, remerged: 'none' })

    const lib = await loadLibraryWith(admin, meal.user_id)
    if (meal.status === 'auto') {
      const { data: all } = await admin.from('meal_estimates').select('model_key, answer, status').eq('meal_id', meal.id)
      const merged = mergeEstimates((all || []).map((e: { model_key: string; answer: unknown; status: string }) => ({ model: e.model_key, answer: e.status === 'ok' ? e.answer : null })), lib)
      if (merged.items.length === 0) return json({ ok: true, stored: status, remerged: 'none' })
      const { error: repError } = await admin.rpc('diet_replace_items', { p_meal_id: meal.id, p_items: storageItems(merged.items), p_meal: { status: 'auto' } })
      if (repError) return json({ ok: false, reason: repError.message })
      return json({ ok: true, stored: status, remerged: 'replaced', items: merged.items.length })
    }
    // Confirmed or edited: the owner's numbers stay; the estimate goes beside them.
    const { data: items } = await admin.from('meal_items').select('id, food_id, name, estimates').eq('meal_id', meal.id)
    const updates = attachEstimates(items || [], 'ollama', answer, lib)
    for (const u of updates) await admin.from('meal_items').update({ estimates: u.estimates }).eq('id', u.id)
    return json({ ok: true, stored: status, remerged: 'attached', items: updates.length })
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    if (req.method === 'GET') return json({ ok: true, service: SERVICE, providers: { anthropic: keys.anthropic, nvidia: keys.nvidia }, worker: keys.worker })
    if (req.method !== 'POST') return json({ ok: false, reason: 'POST only' }, 405)
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return json({ ok: false, reason: 'malformed request body' })
    }
    const action = body?.action ?? 'analyze'
    if (action === 'analyze') return analyze(req, body)
    if (action === 'pending' || action === 'estimate') {
      if (!keys.worker || !workerAllowed(req)) return json({ ok: false, reason: 'worker token missing or wrong' }, 403)
      return action === 'pending' ? pending() : estimate(body)
    }
    return json({ ok: false, reason: `unknown action ${String(action).slice(0, 20)}` })
  }
}
