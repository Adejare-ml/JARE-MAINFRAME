// Tests for the diet-parse handler, with fakes for Supabase and the model.
// Run: cd supabase/functions/diet-parse && deno test --allow-env   (CI runs it; see ci.yml).
// Named *_test.ts, not *.test.ts, so Vitest (which runs tests/ for the app)
// leaves it to Deno.
//
// Added for the Diet module, Phase 2 (docs/diet-module.md).
import { assertEquals, assert, assertMatch } from 'jsr:@std/assert@1.0.13'
import { makeHandler, type ModelAnswer, type Deps } from './handler.ts'
import { ParseResult } from './schema.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'

const rows: Record<string, unknown> = {
  diet_settings: { display_name: 'Ade', city: 'Lokoja', avoid_foods: ['onions'], substitutes: 'cabbage', sex: 'male' },
  foods: [
    { id: 'egg', name: 'Egg, boiled', aliases: ['eggs'], kcal_per_100g: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6, typical_portion_g: 50, portion_label: '1 egg' },
    { id: 'beans', name: 'Brown beans, dry', aliases: ['beans'], kcal_per_100g: 340, protein_g: 22.5, carbs_g: 55, fat_g: 1.6 },
  ],
  recipes: [],
  recipe_ingredients: [],
  saved_meals: [],
}

// A tiny stand-in for the supabase-js query builder: every chain ends in the table's rows.
function fakeClient(userId: string | null, pinnedOwner = OWNER) {
  const query = (table: string) => {
    const data = table === 'jare_owner' ? { user_id: pinnedOwner } : rows[table]
    const result = { data, error: null }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'order', 'limit', 'eq']) chain[m] = () => chain
    chain.maybeSingle = () => Promise.resolve(result)
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok)
    return chain
  }
  return {
    from: query,
    auth: { getUser: () => Promise.resolve(userId ? { data: { user: { id: userId } }, error: null } : { data: null, error: { message: 'no' } }) },
  }
}

const goodAnswer = ParseResult.parse({
  intent: 'both',
  meal_slot: 'breakfast',
  items: [
    { name: '2 boiled eggs', local_name: null, food_id: 'egg', recipe_id: null, saved_meal_id: null, portions: null, grams: 100, grams_low: 90, grams_high: 110, kcal: 999, protein_g: 0, carbs_g: 0, fat_g: 0, hidden: false, confidence: 0.9, basis: 'two eggs' },
  ],
  totals: { kcal: 999, protein_g: 0, carbs_g: 0, fat_g: 0 },
  pantry: [{ action: 'bought', name: 'beans', food_id: null, quantity: 2, unit: 'kg', cost_naira: 3000 }],
  question: null,
})

function setup(over: Partial<Deps> = {}, answers: Array<ModelAnswer | Error> = [{ parsed: goodAnswer, stopReason: 'end_turn' }]) {
  const calls: Array<{ system: string; catalog: string; user: string }> = []
  const env: Record<string, string> = { ANTHROPIC_API_KEY: 'test', ALLOWED_ORIGIN: 'https://app.test' }
  const handler = makeHandler({
    env: (n) => env[n],
    userClient: () => fakeClient(OWNER),
    adminClient: () => fakeClient(null),
    callModel: (args) => {
      calls.push(args)
      const next = answers.shift() ?? { parsed: null, stopReason: 'end_turn' }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    ...over,
  })
  return { handler, calls, env }
}

const post = (body: unknown, auth = 'Bearer jwt') =>
  new Request('https://fn.test/diet-parse', { method: 'POST', headers: auth ? { Authorization: auth, 'Content-Type': 'application/json' } : {}, body: JSON.stringify(body) })

Deno.test('GET is a health probe that names the model and whether a key is set', async () => {
  const { handler } = setup()
  const res = await handler(new Request('https://fn.test/diet-parse'))
  assertEquals(await res.json(), { ok: true, service: 'diet-parse', model: 'claude-haiku-5-5', providers: { anthropic: true } })
  assertEquals(res.headers.get('Access-Control-Allow-Origin'), 'https://app.test')
})

Deno.test('refuses a request with no Authorization header', async () => {
  const { handler } = setup()
  assertEquals((await handler(post({ text: 'eggs' }, ''))).status, 401)
})

Deno.test('answers the pinned owner only', async () => {
  const { handler, calls } = setup({ userClient: () => fakeClient('22222222-2222-4222-8222-222222222222') })
  const res = await handler(post({ text: 'eggs' }))
  assertEquals(res.status, 403)
  assertEquals(calls.length, 0)
})

Deno.test('says plainly when the key is not set, without calling a model', async () => {
  const { handler, calls } = setup({ env: (n) => (n === 'ANTHROPIC_API_KEY' ? undefined : 'https://app.test') })
  const body = await (await handler(post({ text: 'eggs' }))).json()
  assertEquals(body.ok, false)
  assertMatch(body.reason, /ANTHROPIC_API_KEY/)
  assertEquals(calls.length, 0)
})

Deno.test('refuses an empty or overlong note', async () => {
  const { handler } = setup()
  assertMatch((await (await handler(post({ text: '   ' }))).json()).reason, /type or say/)
  assertMatch((await (await handler(post({ text: 'x'.repeat(600) }))).json()).reason, /under 500/)
})

Deno.test('a good answer comes back matched and priced from the foods table', async () => {
  const { handler, calls } = setup()
  const body = await (await handler(post({ text: '2 boiled eggs, and I bought 2 kg beans for 3,000', localTime: '07:40' }))).json()
  assertEquals(body.ok, true)
  assertEquals(body.entry.items[0].food_id, 'egg')
  // 100 g of egg at 155 kcal/100 g, not the 999 the model sent
  assertEquals(body.entry.items[0].kcal, 155)
  assertEquals(body.entry.pantry, [{ action: 'bought', name: 'beans', food_id: 'beans', quantity: 2, unit: 'kg', cost_naira: 3000 }])
  assertEquals(body.entry.meal_slot, 'breakfast')
  // The prompt was filled from settings, the catalogue sent apart from it, the note fenced.
  assertMatch(calls[0].system, /lives in Lokoja, Nigeria/)
  assertMatch(calls[0].system, /He doesn't eat onions\. Use cabbage instead\./)
  assert(!calls[0].system.includes('{{'))
  assertMatch(calls[0].catalog, /^Foods/)
  assertMatch(calls[0].user, /Local time: 07:40/)
  assertMatch(calls[0].user, /<note>\n2 boiled eggs/)
})

Deno.test('retries once when the answer does not validate, then uses the second', async () => {
  const { handler, calls } = setup({}, [{ parsed: null, stopReason: 'invalid' }, { parsed: goodAnswer, stopReason: 'end_turn' }])
  const body = await (await handler(post({ text: 'eggs' }))).json()
  assertEquals(body.ok, true)
  assertEquals(body.attempts, 2)
  assertEquals(calls.length, 2)
})

Deno.test('gives up after two bad answers, and says why', async () => {
  const { handler, calls } = setup({}, [{ parsed: null, stopReason: 'invalid' }, new Error('overloaded')])
  const body = await (await handler(post({ text: 'eggs' }))).json()
  assertEquals(body.ok, false)
  assertMatch(body.reason, /did not match the schema; attempt 2: overloaded/)
  assertEquals(calls.length, 2)
})

Deno.test('a refusal is reported, not retried', async () => {
  const { handler, calls } = setup({}, [{ parsed: null, stopReason: 'refusal' }])
  const body = await (await handler(post({ text: 'eggs' }))).json()
  assertEquals(body.ok, false)
  assertMatch(body.reason, /declined/)
  assertEquals(calls.length, 1)
})

Deno.test('the schema refuses quantities written as strings', () => {
  const bad = structuredClone(goodAnswer) as Record<string, unknown>
  ;(bad.items as Array<Record<string, unknown>>)[0].grams = '100'
  assertEquals(ParseResult.safeParse(bad).success, false)
})
