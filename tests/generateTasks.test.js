import { describe, it, expect, beforeEach } from 'vitest'
import { generateTasks } from '../src/lib/generateTasks.js'
import { setSchemaCapabilities, resetSchemaCapabilities } from '../src/lib/schema.js'
import { GENERATED_SLOT_BASE } from '../src/lib/planning.js'

beforeEach(() => resetSchemaCapabilities())

/** Monday 10 August 2026. */
const TODAY = '2026-08-10'

const monthlyGoal = {
  id: 'm1',
  period: 'monthly',
  target_date: '2026-08-01',
  title: 'Laptop fund',
  metric: 'save_at_least',
  target_amount: 150000,
  metric_category: 'Savings',
  slot: 0,
  generated: false,
}

/**
 * A stand-in for the supabase client that records writes and replays canned
 * reads. Enough to drive the orchestration without a database.
 */
function fakeClient({ goals = [], transactions = [], failMessage = null } = {}) {
  const writes = []

  // The real builder is thenable at every step and keeps chaining, which
  // matters here: `excludeVoided` appends `.eq('voided', false)` AFTER the
  // caller's `.gte(...)`, so a fake that resolves on `.gte` breaks before the
  // query is even finished being built.
  const chainFor = (rows) => {
    const chain = {
      select: () => chain,
      gte: () => chain,
      lte: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (onOk, onErr) =>
        Promise.resolve(
          failMessage ? { data: null, error: { message: failMessage } } : { data: rows, error: null },
        ).then(onOk, onErr),
    }
    return chain
  }

  const from = (table) => {
    const rows = table === 'goals' ? goals : transactions
    const chain = chainFor(rows)

    chain.upsert = (written, opts) => {
      writes.push({ table, rows: written, opts })
      // Ids derived from lineage rather than a counter, so a row written on one
      // run is recognisably the same row on the next -- which is exactly what
      // the real database's unique index guarantees.
      return chainFor(
        written.map((r) => ({ ...r, id: r.id || `${r.parent_id}:${r.period}:${r.target_date}` })),
      )
    }

    return chain
  }

  return { from, writes }
}

describe('generateTasks', () => {
  it('does nothing at all when migration 009 has not run', async () => {
    // Every column it writes arrives with 009. Attempting the write would be a
    // page-load full of PGRST204s.
    setSchemaCapabilities(['goals.metric'])
    const client = fakeClient({ goals: [monthlyGoal] })

    const result = await generateTasks(client, { today: TODAY })

    expect(result.skipped).toMatch(/009/)
    expect(result.written).toBe(0)
    expect(client.writes).toHaveLength(0)
  })

  it('derives a weekly target from a monthly goal, then a daily task from that', async () => {
    const client = fakeClient({ goals: [monthlyGoal], transactions: [] })

    const result = await generateTasks(client, { today: TODAY })

    expect(result.written).toBeGreaterThan(0)
    const periods = client.writes.flatMap((w) => w.rows.map((r) => r.period))
    expect(periods).toContain('weekly')
    expect(periods).toContain('daily')
  })

  it('marks everything it writes as generated, in the generated slot range', async () => {
    // 009's goals_generated_slot_range check rejects a generated row below 10,
    // so getting this wrong is a constraint violation, not a cosmetic slip.
    const client = fakeClient({ goals: [monthlyGoal] })
    await generateTasks(client, { today: TODAY })

    for (const write of client.writes) {
      for (const row of write.rows) {
        expect(row.generated).toBe(true)
        expect(row.slot).toBeGreaterThanOrEqual(GENERATED_SLOT_BASE)
      }
    }
  })

  it('links each derived row to the goal that produced it', async () => {
    const client = fakeClient({ goals: [monthlyGoal] })
    await generateTasks(client, { today: TODAY })

    const weekly = client.writes.flatMap((w) => w.rows).find((r) => r.period === 'weekly')
    expect(weekly.parent_id).toBe('m1')
  })

  it('upserts on the slot key so a second run cannot duplicate', async () => {
    const client = fakeClient({ goals: [monthlyGoal] })
    await generateTasks(client, { today: TODAY })

    for (const write of client.writes) {
      expect(write.opts.onConflict).toBe('period,target_date,slot')
    }
  })

  it('never writes `completed`', async () => {
    // reconcileGenerated reads `completed` as "a person touched this row" and
    // stops regenerating it. A generator that ticked its own output would
    // freeze the figure the moment the target was first met.
    const client = fakeClient({ goals: [monthlyGoal] })
    await generateTasks(client, { today: TODAY })

    for (const write of client.writes) {
      for (const row of write.rows) {
        expect(row).not.toHaveProperty('completed')
      }
    }
  })

  it('writes nothing on a second run when nothing has changed', async () => {
    // Generation runs on every page load, so the steady state has to be free.
    const first = fakeClient({ goals: [monthlyGoal] })
    await generateTasks(first, { today: TODAY })

    // Stored with the same ids the fake handed back, so the daily row's
    // parent_id still points at the weekly row it came from.
    const produced = first.writes.flatMap((w) =>
      w.rows.map((r) => ({
        ...r,
        id: r.id || `${r.parent_id}:${r.period}:${r.target_date}`,
        completed: false,
      })),
    )

    const second = fakeClient({ goals: [monthlyGoal, ...produced] })
    const result = await generateTasks(second, { today: TODAY })

    expect(second.writes).toHaveLength(0)
    expect(result.written).toBe(0)
    expect(result.unchanged).toBeGreaterThan(0)
  })

  it('leaves a ticked task alone', async () => {
    const stored = {
      id: 'd1',
      parent_id: 'w1',
      period: 'daily',
      target_date: TODAY,
      slot: GENERATED_SLOT_BASE,
      title: 'Set aside ₦1 today',
      target_amount: 1,
      generated: true,
      completed: true,
    }
    const weeklyGoal = {
      id: 'w1',
      period: 'weekly',
      target_date: TODAY,
      title: 'Laptop fund',
      metric: 'save_at_least',
      target_amount: 35000,
      metric_category: 'Savings',
      slot: GENERATED_SLOT_BASE,
      generated: true,
    }

    const client = fakeClient({ goals: [weeklyGoal, stored] })
    const result = await generateTasks(client, { today: TODAY })

    const dailyWrites = client.writes.flatMap((w) => w.rows).filter((r) => r.period === 'daily')
    expect(dailyWrites).toHaveLength(0)
    expect(result.kept).toBeGreaterThan(0)
  })

  it('ignores manual goals, which have nothing to decompose', async () => {
    const client = fakeClient({
      goals: [{ ...monthlyGoal, metric: 'manual', target_amount: null, metric_category: null }],
    })
    await generateTasks(client, { today: TODAY })
    expect(client.writes).toHaveLength(0)
  })

  it('reports a failure instead of throwing', async () => {
    // This runs without the user asking. A generator that cannot run must cost
    // the generated tasks and nothing else -- it must not take Daily HQ down.
    const result = await generateTasks(fakeClient({ failMessage: 'offline' }), { today: TODAY })
    expect(result.error).toBe('offline')
    expect(result.written).toBe(0)
  })
})

describe('the shape of what it writes', () => {
  it('sends every row in an upsert with the same keys', async () => {
    // PostgREST rejects a bulk upsert whose objects do not all carry the same
    // keys -- PGRST102, "All object keys must match". reconcileGenerated used
    // to attach `id` to updates and not to inserts, so the array became
    // heterogeneous the moment you held two goals and only one had moved, and
    // the whole write 400'd. Nothing caught it: the fake client here does not
    // validate keys, and with one goal the array is never mixed.
    const second = { ...monthlyGoal, id: 'm2', slot: 2, title: 'Rent buffer' }

    // One parent with a stored task whose figure has moved (an update), and one
    // never seen before (an insert) -- the exact combination that broke.
    const storedWeekly = {
      id: 'w-old',
      parent_id: 'm1',
      period: 'weekly',
      target_date: '2026-08-10',
      slot: GENERATED_SLOT_BASE,
      title: 'Set aside \u20a61 toward Laptop fund',
      target_amount: 1,
      generated: true,
      completed: false,
    }

    const client = fakeClient({ goals: [monthlyGoal, second, storedWeekly], transactions: [] })
    await generateTasks(client, { today: TODAY })

    expect(client.writes.length).toBeGreaterThan(0)
    for (const write of client.writes) {
      const shapes = new Set(write.rows.map((r) => Object.keys(r).sort().join(',')))
      expect([...shapes]).toHaveLength(1)
    }
  })

  it('never sends an id, so the unique index does the arbitrating', async () => {
    const client = fakeClient({ goals: [monthlyGoal] })
    await generateTasks(client, { today: TODAY })

    for (const write of client.writes) {
      for (const row of write.rows) expect(row).not.toHaveProperty('id')
    }
  })
})

describe('generateTasks on a goal about code', () => {
  const repoMonthly = {
    id: 'rm1',
    period: 'monthly',
    target_date: '2026-08-01',
    title: 'Ship the planner',
    metric: 'repo_commits',
    target_amount: 40,
    slot: 1,
    generated: false,
  }

  it('decomposes it exactly as it decomposes money', async () => {
    // The reason stage 7 could be built before the model-written plans of
    // stage 8: nothing in the chain is money-specific, so a coding goal already
    // had a working generator. Only the wording and the unit differ.
    const client = fakeClient({ goals: [repoMonthly], transactions: [] })
    const result = await generateTasks(client, { today: TODAY })

    expect(result.written).toBeGreaterThan(0)
    const rows = client.writes.flatMap((w) => w.rows)
    expect(rows.map((row) => row.period)).toEqual(expect.arrayContaining(['weekly', 'daily']))

    for (const row of rows) {
      expect(row.metric).toBe('repo_commits')
      expect(row.title).not.toContain('\u20a6')
      // 010's amended check accepts a repo goal with neither, and a derived row
      // that picked one up would be measured against a category on a card about
      // code.
      expect(row.metric_category).toBe(null)
      expect(row.metric_wallet_id).toBe(null)
    }
  })

  it('never writes `completed`, `evidence` or `verified_at`', async () => {
    // The verifier owns those three columns, and it runs somewhere else. A
    // generator that wrote them would be asserting a result nobody has checked
    // -- and reconcileGenerated reads `completed` as "a person touched this",
    // so it would also freeze the row against every later run.
    const client = fakeClient({ goals: [repoMonthly] })
    await generateTasks(client, { today: TODAY })

    for (const write of client.writes) {
      for (const row of write.rows) {
        expect(row).not.toHaveProperty('completed')
        expect(row).not.toHaveProperty('evidence')
        expect(row).not.toHaveProperty('verified_at')
      }
    }
  })
})
