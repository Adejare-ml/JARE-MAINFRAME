// Tests for the diet-photo handler, with fakes for Supabase and the models.
// Run: cd supabase/functions/diet-photo && deno test --allow-env   (CI runs it).
// Named *_test.ts so Vitest leaves it to Deno.
//
// Added for the Diet module, Phase 3 (docs/diet-module.md).
import { assertEquals, assert, assertMatch } from 'jsr:@std/assert@1.0.13'
import { makeHandler, runModel, type Deps, type ModelReply } from './handler.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const PHOTO = `${OWNER}/2026/11/0b6c2d8e-6a5d-4c3e-9a8b-1f2e3d4c5b6a.jpg`

type Row = Record<string, unknown>

/** A recording stand-in for supabase-js: reads come from `tables`, writes are kept in `writes`. */
function fakeDb(tables: Record<string, Row[] | Row | null>, userId: string | null = OWNER) {
  const writes: Array<{ op: string; table: string; value: unknown; filters?: Row }> = []
  const query = (table: string) => {
    const filters: Row = {}
    let single = false
    let payload: { op: string; value: unknown } | null = null
    const result = () => {
      if (payload) {
        writes.push({ op: payload.op, table, value: payload.value, filters: { ...filters } })
        return { data: null, error: null }
      }
      let data = tables[table] ?? null
      if (Array.isArray(data)) {
        data = data.filter((r) => Object.entries(filters).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)))
        if (single) data = data[0] ?? null
      }
      return { data, error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      not: () => chain,
      gte: () => chain,
      eq: (k: string, v: unknown) => ((filters[k] = v), chain),
      in: (k: string, v: unknown[]) => ((filters[k] = v), chain),
      maybeSingle: () => ((single = true), Promise.resolve(result())),
      update: (value: unknown) => ((payload = { op: 'update', value }), chain),
      upsert: (value: unknown) => ((payload = { op: 'upsert', value }), Promise.resolve(result())),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
    }
    return chain
  }
  const client = {
    from: query,
    rpc: (name: string, args: Row) => {
      writes.push({ op: 'rpc', table: name, value: args })
      return Promise.resolve({ data: { id: 'meal-1', kcal: 0 }, error: null })
    },
    auth: { getUser: () => Promise.resolve(userId ? { data: { user: { id: userId } }, error: null } : { data: null, error: { message: 'no' } }) },
    storage: {
      from: () => ({
        download: () => Promise.resolve({ data: new Blob([new Uint8Array([255, 216, 255, 224])]), error: null }),
        createSignedUrl: (path: string) => Promise.resolve({ data: { signedUrl: `https://signed.test/${path}?token=t` }, error: null }),
      }),
    },
  }
  return { client, writes }
}

const library = {
  jare_owner: { user_id: OWNER },
  diet_settings: { user_id: OWNER, display_name: 'Ade', city: 'Lokoja', sex: 'male', avoid_foods: ['onions'], substitutes: 'cabbage', nvidia_vision_model: null, ollama_vision_model: null },
  foods: [{ id: 'rice', user_id: OWNER, name: 'White rice, boiled', aliases: ['rice', 'white rice'], kcal_per_100g: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3 }],
  recipes: [],
  recipe_ingredients: [],
  saved_meals: [],
}

const vision = (items: Row[], extra: Row = {}) => ({ items, totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, image_quality: 'good', question: null, ...extra })
const it_ = (o: Row) => ({ name: 'x', local_name: null, grams: 0, grams_low: 0, grams_high: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, hidden: false, confidence: 0.8, basis: 'test', ...o })

function setup(opts: { claude?: Array<ModelReply | Error>; nvidia?: Array<ModelReply | Error>; env?: Record<string, string>; tables?: Record<string, Row[] | Row | null>; user?: string | null } = {}) {
  const env: Record<string, string> = { ANTHROPIC_API_KEY: 'k', NVIDIA_API_KEY: 'k', DIET_WORKER_TOKEN: 'worker-secret-123', ALLOWED_ORIGIN: 'https://app.test', ...opts.env }
  const user = fakeDb({ ...library, ...opts.tables }, opts.user === undefined ? OWNER : opts.user)
  const admin = fakeDb({ ...library, ...opts.tables })
  const calls = { claude: 0, nvidia: 0, prompts: [] as string[] }
  const queue = (list: Array<ModelReply | Error>) => () => {
    const next = list.shift() ?? { answer: null }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  }
  const claudeQ = queue(opts.claude ?? [{ answer: vision([it_({ name: 'white rice', grams: 250 })]) }])
  const nvidiaQ = queue(opts.nvidia ?? [{ answer: vision([it_({ name: 'rice', grams: 300 })]) }])
  const deps: Deps = {
    env: (n) => env[n],
    userClient: () => user.client,
    adminClient: () => admin.client,
    callClaude: (a) => ((calls.claude++, calls.prompts.push(a.system)), claudeQ()),
    callNvidia: () => (calls.nvidia++, nvidiaQ()),
    now: () => new Date('2026-11-10T12:00:00Z'),
  }
  return { handler: makeHandler(deps), user, admin, calls }
}

const post = (body: unknown, headers: Record<string, string> = { Authorization: 'Bearer jwt' }) =>
  new Request('https://fn.test/diet-photo', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

Deno.test('GET reports which keys are set, never their values', async () => {
  const body = await (await setup().handler(new Request('https://fn.test/diet-photo'))).json()
  assertEquals(body, { ok: true, service: 'diet-photo', providers: { anthropic: true, nvidia: true }, worker: true })
})

Deno.test('analyze: two models, merged with median grams, logged as auto, every estimate stored', async () => {
  const { handler, user, calls } = setup()
  const body = await (await handler(post({ action: 'analyze', photo_path: PHOTO, note: 'mama put', localTime: '13:10' }))).json()
  assertEquals(body.ok, true)
  assertEquals(body.meal_id, 'meal-1')
  const rice = body.entry.items[0]
  assertEquals(rice.food_id, 'rice')
  assertEquals(rice.grams, 275)
  assertEquals(rice.kcal, 358)
  assertEquals(calls.claude, 1)
  assertEquals(calls.nvidia, 1)
  assertMatch(calls.prompts[0], /lives in Lokoja, Nigeria/)
  const rpc = user.writes.find((w) => w.op === 'rpc')!
  assertEquals(rpc.table, 'log_diet_meal')
  assertEquals((rpc.value as Row).p_meal, { source: 'photo', status: 'auto', meal_slot: 'lunch', raw_text: 'mama put' })
  const est = user.writes.find((w) => w.table === 'meal_estimates')!.value as Row[]
  assertEquals(est.map((e) => [e.model_key, e.status]), [['claude', 'ok'], ['nvidia', 'ok']])
  assert(user.writes.some((w) => w.table === 'meal_logs' && (w.value as Row).photo_path === PHOTO))
})

Deno.test('analyze: refuses a photo path in someone else\'s folder', async () => {
  const other = PHOTO.replace(OWNER, '22222222-2222-4222-8222-222222222222')
  const body = await (await setup().handler(post({ action: 'analyze', photo_path: other }))).json()
  assertEquals(body.ok, false)
  assertMatch(body.reason, /not one of yours/)
})

Deno.test('analyze: the owner only', async () => {
  const res = await setup({ user: '22222222-2222-4222-8222-222222222222' }).handler(post({ action: 'analyze', photo_path: PHOTO }))
  assertEquals(res.status, 403)
})

Deno.test('analyze: one model down still logs the meal from the other (Ollama is never waited for)', async () => {
  const { handler, user } = setup({ nvidia: [new Error('NVIDIA 503: busy')] })
  const body = await (await handler(post({ action: 'analyze', photo_path: PHOTO }))).json()
  assertEquals(body.ok, true)
  assertEquals(body.entry.single_model, true)
  assertEquals(body.models.find((m: Row) => m.model_key === 'nvidia').status, 'error')
  const est = user.writes.find((w) => w.table === 'meal_estimates')!.value as Row[]
  assertMatch(String(est.find((e) => e.model_key === 'nvidia')!.reason), /503/)
})

Deno.test('analyze: an invalid answer is retried once, then that model is skipped with the reason', async () => {
  const { handler, calls } = setup({ nvidia: [{ answer: { items: 'nope' } }, { answer: { items: [] } }] })
  const body = await (await handler(post({ action: 'analyze', photo_path: PHOTO }))).json()
  assertEquals(calls.nvidia, 2)
  const nv = body.models.find((m: Row) => m.model_key === 'nvidia')
  assertEquals(nv.status, 'invalid')
  assertEquals(nv.attempts, 2)
  assertMatch(nv.reason, /did not match the schema/)
  assertEquals(body.ok, true)
})

Deno.test('analyze: no model answering is an error and nothing is logged', async () => {
  const { handler, user } = setup({ claude: [new Error('overloaded')], nvidia: [new Error('down')] })
  const body = await (await handler(post({ action: 'analyze', photo_path: PHOTO }))).json()
  assertEquals(body.ok, false)
  assertMatch(body.reason, /no model could read the photo/)
  assertEquals(user.writes.filter((w) => w.op === 'rpc').length, 0)
})

Deno.test('analyze: a photo with no food logs nothing and says so', async () => {
  const none = { answer: vision([], { image_quality: 'no_food' }) }
  const { handler, user } = setup({ claude: [none], nvidia: [{ answer: vision([], { image_quality: 'no_food' }) }] })
  const body = await (await handler(post({ action: 'analyze', photo_path: PHOTO }))).json()
  assertEquals(body.no_food, true)
  assertEquals(user.writes.filter((w) => w.op === 'rpc').length, 0)
})

Deno.test('analyze: a refusal is not retried', async () => {
  const { handler, calls } = setup({ claude: [{ answer: null, stopReason: 'refusal' }] })
  const body = await (await handler(post({ action: 'analyze', photo_path: PHOTO }))).json()
  assertEquals(calls.claude, 1)
  assertEquals(body.models.find((m: Row) => m.model_key === 'claude').status, 'refused')
})

Deno.test('worker actions need the worker token', async () => {
  const { handler } = setup()
  assertEquals((await handler(post({ action: 'pending' }, {}))).status, 403)
  assertEquals((await handler(post({ action: 'pending' }, { 'x-worker-token': 'worker-secret-12X' }))).status, 403)
  assertEquals((await setup({ env: { DIET_WORKER_TOKEN: '' } }).handler(post({ action: 'pending' }, { 'x-worker-token': '' }))).status, 403)
})

Deno.test('pending: photo meals without an Ollama estimate, with a signed URL and the filled prompt', async () => {
  const meals = [
    { id: 'm1', user_id: OWNER, source: 'photo', photo_path: PHOTO, raw_text: null, eaten_at: '2026-11-10T12:10:00Z', status: 'auto' },
    { id: 'm2', user_id: OWNER, source: 'photo', photo_path: PHOTO, raw_text: 'suya', eaten_at: '2026-11-10T19:00:00Z', status: 'confirmed' },
  ]
  const { handler } = setup({ tables: { meal_logs: meals, meal_estimates: [{ meal_id: 'm1', model_key: 'ollama' }] } })
  const body = await (await handler(post({ action: 'pending' }, { 'x-worker-token': 'worker-secret-123' }))).json()
  assertEquals(body.jobs.length, 1)
  assertEquals(body.jobs[0].meal_id, 'm2')
  assertEquals(body.jobs[0].model, 'qwen3-vl:8b')
  assertMatch(body.jobs[0].image_url, /^https:\/\/signed\.test\//)
  assertMatch(body.jobs[0].system, /lives in Lokoja/)
  assertMatch(body.jobs[0].user, /Local time: 20:00[\s\S]*suya/)
})

Deno.test('estimate: a late estimate re-merges a meal still waiting for the owner', async () => {
  const meals = [{ id: 'm1', user_id: OWNER, status: 'auto' }]
  const estimates = [
    { meal_id: 'm1', model_key: 'claude', status: 'ok', answer: vision([it_({ name: 'rice', grams: 250 })]) },
    { meal_id: 'm1', model_key: 'nvidia', status: 'ok', answer: vision([it_({ name: 'rice', grams: 300 })]) },
    { meal_id: 'm1', model_key: 'ollama', status: 'ok', answer: vision([it_({ name: 'rice', grams: 200 })]) },
  ]
  const { handler, admin } = setup({ tables: { meal_logs: meals, meal_estimates: estimates } })
  const body = await (await handler(post({ action: 'estimate', meal_id: 'm1', status: 'ok', model_id: 'qwen3-vl:8b', answer: vision([it_({ name: 'rice', grams: 200 })]), latency_ms: 41000, attempts: 1 }, { 'x-worker-token': 'worker-secret-123' }))).json()
  assertEquals(body.remerged, 'replaced')
  const rpc = admin.writes.find((w) => w.op === 'rpc')!
  assertEquals(rpc.table, 'diet_replace_items')
  const items = (rpc.value as Row).p_items as Row[]
  assertEquals(items[0].grams, 250)
  assertEquals(Object.keys(items[0].estimates as Row).sort(), ['claude', 'nvidia', 'ollama'])
  assertEquals((rpc.value as Row).p_meal, { status: 'auto' })
})

Deno.test('estimate: a confirmed meal keeps its numbers and only gains the estimate', async () => {
  const meals = [{ id: 'm1', user_id: OWNER, status: 'confirmed' }]
  const items = [{ id: 'i1', meal_id: 'm1', food_id: 'rice', name: 'White rice, boiled', estimates: { claude: { grams: 250 } } }]
  const { handler, admin } = setup({ tables: { meal_logs: meals, meal_items: items } })
  const body = await (await handler(post({ action: 'estimate', meal_id: 'm1', status: 'ok', answer: vision([it_({ name: 'rice', grams: 200 })]) }, { 'x-worker-token': 'worker-secret-123' }))).json()
  assertEquals(body.remerged, 'attached')
  assertEquals(admin.writes.filter((w) => w.op === 'rpc').length, 0)
  const upd = admin.writes.find((w) => w.op === 'update' && w.table === 'meal_items')!
  assertEquals((upd.value as Row).estimates, { claude: { grams: 250 }, ollama: it_({ name: 'rice', grams: 200 }) })
})

Deno.test('estimate: an answer that fails the server schema is stored as invalid and merges nothing', async () => {
  const { handler, admin } = setup({ tables: { meal_logs: [{ id: 'm1', user_id: OWNER, status: 'auto' }] } })
  const body = await (await handler(post({ action: 'estimate', meal_id: 'm1', status: 'ok', answer: { items: [{ name: 'rice', grams: '200' }] } }, { 'x-worker-token': 'worker-secret-123' }))).json()
  assertEquals(body.stored, 'invalid')
  assertEquals(body.remerged, 'none')
  const up = admin.writes.find((w) => w.table === 'meal_estimates')!.value as Row
  assertEquals(up.status, 'invalid')
  assertEquals(up.user_id, OWNER)
})

Deno.test('runModel: a thrown error is reported once, not retried', async () => {
  let n = 0
  const e = await runModel('nvidia', 'm', () => (n++, Promise.reject(new Error('NVIDIA 401'))))
  assertEquals([e.status, n], ['error', 1])
})
