// Tests for the diet-coach handler, with fakes for Supabase and the model.
// Run: cd supabase/functions/diet-coach && deno test --allow-env   (CI runs it).
//
// Added for the Diet module, Phase 4 (docs/diet-module.md).
import { assertEquals, assertMatch, assert } from 'jsr:@std/assert@1.0.13'
import { makeHandler, type Deps } from './handler.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
type Row = Record<string, unknown>

function fakeDb(tables: Record<string, Row[] | Row | null>, userId: string | null = OWNER) {
  const writes: Array<{ table: string; value: unknown; filters: Row }> = []
  const query = (table: string) => {
    const filters: Row = {}
    let single = false
    let update: unknown = null
    const result = () => {
      if (update) {
        writes.push({ table, value: update, filters: { ...filters } })
        return { data: null, error: null }
      }
      let data = tables[table] ?? null
      if (Array.isArray(data)) {
        data = data.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
        if (single) data = data[0] ?? null
      }
      return { data, error: null }
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      gte: () => chain,
      lte: () => chain,
      eq: (k: string, v: unknown) => ((filters[k] = v), chain),
      maybeSingle: () => ((single = true), Promise.resolve(result())),
      update: (v: unknown) => ((update = v), chain),
      then: (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok),
    }
    return chain
  }
  return {
    client: { from: query, auth: { getUser: () => Promise.resolve(userId ? { data: { user: { id: userId } }, error: null } : { data: null, error: { message: 'no' } }) } },
    writes,
  }
}

const settings = { kcal_target: 2300, protein_target_g: 100, meal_split: { breakfast: 0.2, lunch: 0.35, dinner: 0.3, snacks: 0.15 }, display_name: 'Ade', sex: 'male', avoid_foods: ['onions'], substitutes: 'cabbage and carrots' }
const meals = [
  { id: 'b', eaten_on: '2026-11-10', eaten_at: '2026-11-10T06:45:00Z', meal_slot: 'breakfast', source: 'saved', kcal: 442, protein_g: 20.3, meal_items: [{ name: 'Egg, boiled' }] },
  { id: 'l', eaten_on: '2026-11-10', eaten_at: '2026-11-10T12:30:00Z', meal_slot: 'lunch', source: 'photo', kcal: 800, protein_g: 46, meal_items: [{ name: 'Beans pot' }] },
]

function setup(answers: Array<{ answer: unknown; stopReason?: string } | Error> = [], user: string = OWNER) {
  const db = fakeDb({ jare_owner: { user_id: OWNER }, diet_settings: settings, meal_logs: meals, diet_daily_totals: [], pantry_items: [{ name: 'eggs', quantity: 27, unit: 'eggs', finished: false }] }, user)
  const calls: Array<{ system: string; user: string }> = []
  const deps: Deps = {
    env: (n) => ({ ANTHROPIC_API_KEY: 'k', ALLOWED_ORIGIN: 'https://app.test' } as Record<string, string>)[n],
    userClient: () => db.client,
    adminClient: () => fakeDb({ jare_owner: { user_id: OWNER } }).client,
    callModel: (a) => {
      calls.push(a)
      const next = answers.shift() ?? { answer: null }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    },
    now: () => new Date('2026-11-10T15:00:00Z'),
  }
  return { handler: makeHandler(deps), db, calls }
}

const post = (body: unknown) => new Request('https://fn.test/diet-coach', { method: 'POST', headers: { Authorization: 'Bearer jwt', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const answer = (o: Row = {}) => ({ verdict: 'fits', reason: '800 kcal and 46 g protein. Leaves you 1,058 kcal.', next_options: [], flag: null, ...o })

Deno.test('verdict: a photo meal gets the coach, its reason kept when it agrees with the rules', async () => {
  const { handler, db, calls } = setup([{ answer: answer() }])
  const body = await (await handler(post({ action: 'verdict', meal_id: 'l' }))).json()
  assertEquals(body, { ok: true, verdict: 'fits', reason: '800 kcal and 46 g protein. Leaves you 1,058 kcal.', agreed: true, flag: null, from: 'coach' })
  assertMatch(calls[0].system, /inside Ade's Jare Mainframe app/)
  assertMatch(calls[0].system, /He doesn't eat onions\. Use cabbage and carrots instead\./)
  const input = JSON.parse(calls[0].user)
  assertEquals(input.meal.kcal, 800)
  assertEquals(input.today.meals.length, 1)
  const w = db.writes[0]
  assertEquals((w.value as Row).verdict, 'fits')
  assertEquals(((w.value as Row).coach as Row).agreed, true)
})

Deno.test('verdict: the rule wins when the coach disagrees, and the disagreement is kept', async () => {
  const { handler, db } = setup([{ answer: answer({ verdict: 'over', reason: 'Way over.' }) }])
  const body = await (await handler(post({ action: 'verdict', meal_id: 'l' }))).json()
  assertEquals([body.verdict, body.agreed], ['fits', false])
  assertMatch(body.reason, /Leaves you 1,058 kcal for the rest of the day/)
  assertEquals(((db.writes[0].value as Row).coach as Row).verdict, 'over')
})

Deno.test('verdict: a saved meal is judged in code, with no model call', async () => {
  const { handler, calls, db } = setup()
  const body = await (await handler(post({ action: 'verdict', meal_id: 'b' }))).json()
  assertEquals(body.from, 'code')
  assertEquals(body.verdict, 'fits')
  assertEquals(calls.length, 0)
  assertEquals(db.writes.length, 0)
})

Deno.test('verdict: one retry on a bad answer, then the code verdict stays', async () => {
  const { handler, calls, db } = setup([{ answer: { verdict: 'great' } }, { answer: { reason: 1 } }])
  const body = await (await handler(post({ action: 'verdict', meal_id: 'l' }))).json()
  assertEquals(body.ok, false)
  assertEquals(body.verdict, 'fits')
  assertEquals(calls.length, 2)
  assertEquals(db.writes.length, 0)
})

Deno.test('verdict: a refusal is not retried', async () => {
  const { handler, calls } = setup([{ answer: null, stopReason: 'refusal' }])
  const body = await (await handler(post({ action: 'verdict', meal_id: 'l' }))).json()
  assertMatch(body.reason, /declined/)
  assertEquals(calls.length, 1)
})

Deno.test('next: options checked (no avoided food, no skipping), pantry first, at most three', async () => {
  const opts = [
    { meal: 'Suya, lean pieces, no bread', kcal: 400, protein_g: 35, from_pantry: false, why: 'protein' },
    { meal: 'Egg sauce with onions', kcal: 450, protein_g: 20, from_pantry: true, why: 'eggs at home' },
    { meal: '3 eggs scrambled with cabbage and carrots', kcal: 520, protein_g: 21, from_pantry: true, why: 'fits what is left' },
  ]
  const { handler, calls } = setup([{ answer: answer({ verdict: null, reason: '1,058 kcal left — plenty.', next_options: opts }) }])
  const body = await (await handler(post({ action: 'next' }))).json()
  assertEquals(body.ok, true)
  assertEquals(body.next_options.map((o: Row) => o.meal), ['3 eggs scrambled with cabbage and carrots', 'Suya, lean pieces, no bread'])
  assertEquals(body.reason, '1,058 kcal left, plenty.')
  const input = JSON.parse(calls[0].user)
  assertEquals(input.meal, null)
  assertEquals(input.today.meals.length, 2)
  assertEquals(input.time, '16:00')
  assertEquals(input.pantry, [{ name: 'eggs', quantity: 27, unit: 'eggs' }])
})

Deno.test('the owner only', async () => {
  const res = await setup([], '22222222-2222-4222-8222-222222222222').handler(post({ action: 'next' }))
  assertEquals(res.status, 403)
})

Deno.test('GET reports whether the key is set', async () => {
  const body = await (await setup().handler(new Request('https://fn.test/diet-coach'))).json()
  assert(body.providers.anthropic)
  assertEquals(body.model, 'claude-haiku-5-5')
})
