import { describe, it, expect } from 'vitest'
import {
  isTaskDone,
  daysBetween,
  weeksRemaining,
  goalProgress,
  pace,
  decomposeMonthly,
  decomposeWeekly,

  reconcileGenerated,
  GENERATED_SLOT_BASE,
  MAX_GENERATED_PER_DAY,
} from '../src/lib/planning.js'

/** August 2026: the 1st is a Saturday, the 10th a Monday, the 31st a Monday. */
const AUG_END = '2026-08-31'

describe('daysBetween', () => {
  it('counts both ends', () => {
    // A goal due on the 31st can still be worked on during the 31st. Counting
    // exclusively is how a plan quietly loses its last day.
    expect(daysBetween('2026-08-10', '2026-08-10')).toBe(1)
    expect(daysBetween('2026-08-10', '2026-08-16')).toBe(7)
  })

  it('crosses months and years', () => {
    expect(daysBetween('2026-08-31', '2026-09-01')).toBe(2)
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(2)
  })

  it('returns 0 for junk rather than NaN', () => {
    // NaN propagates into a division and renders as "₦NaN", which looks like a
    // bug in the money rather than in the date.
    expect(daysBetween(null, '2026-08-10')).toBe(0)
    expect(daysBetween('not-a-date', '2026-08-10')).toBe(0)
  })
})

describe('weeksRemaining', () => {
  it('counts the current part-week as one', () => {
    // Mon 10th to Sun 30th is three calendar weeks; the 31st starts a fourth.
    expect(weeksRemaining(AUG_END, '2026-08-10')).toBe(3)
  })

  it('never returns zero', () => {
    // Dividing by zero makes the weekly target Infinity, which renders as a
    // nonsense number instead of an honest "this is due now".
    expect(weeksRemaining(AUG_END, AUG_END)).toBe(1)
    expect(weeksRemaining('2026-08-01', '2026-08-20')).toBe(1)
    expect(weeksRemaining(null, '2026-08-20')).toBe(1)
  })

  it('shrinks as the month runs out', () => {
    const early = weeksRemaining(AUG_END, '2026-08-03')
    const late = weeksRemaining(AUG_END, '2026-08-24')
    expect(early).toBeGreaterThan(late)
  })
})

describe('goalProgress', () => {
  const saving = {
    metric: 'save_at_least',
    target_amount: 40000,
    metric_category: 'Savings',
  }

  it('reads a savings goal from the ledger instead of a checkbox', () => {
    // The point of the whole feature: the goal answers for itself from the
    // transactions the Gmail sync already imported.
    const result = goalProgress(saving, [
      { type: 'credit', amount: 15000, category: 'Savings' },
      { type: 'credit', amount: 10000, category: 'Savings' },
      { type: 'credit', amount: 99000, category: 'Salary' },
    ])
    expect(result.done).toBe(25000)
    expect(result.target).toBe(40000)
    expect(result.met).toBe(false)
    expect(result.measured).toBe(true)
  })

  it('says how it knows', () => {
    // A number the app computed has to be able to explain itself.
    expect(goalProgress(saving, []).source).toContain('Savings')
    expect(goalProgress({ metric: 'manual' }).source).toBe('ticked by hand')
  })

  it('meets a savings goal only once the target is reached', () => {
    expect(goalProgress(saving, [{ type: 'credit', amount: 40000, category: 'Savings' }]).met).toBe(true)
    expect(goalProgress(saving, [{ type: 'credit', amount: 39999, category: 'Savings' }]).met).toBe(false)
  })

  it('meets a spending cap while you are still under it', () => {
    // Opposite comparison to saving, same number. Getting this backwards would
    // report a blown budget as a success.
    const cap = { metric: 'spend_under', target_amount: 20000, metric_category: 'Food' }
    expect(goalProgress(cap, [{ type: 'debit', amount: 5000, category: 'Food' }]).met).toBe(true)
    expect(goalProgress(cap, [{ type: 'debit', amount: 25000, category: 'Food' }]).met).toBe(false)
  })

  it('does not count a transfer as spending', () => {
    // Moving money to PiggyVest writes a debit on GTBank. Counting it as
    // spending made saving look like overspending -- the same bug summarizeMonth
    // was fixed for.
    const cap = { metric: 'spend_under', target_amount: 20000, metric_wallet_id: 'w1' }
    const result = goalProgress(cap, [
      { type: 'debit', amount: 50000, category: 'Savings Transfer', wallet_id: 'w1' },
      { type: 'debit', amount: 3000, category: 'Food', wallet_id: 'w1' },
    ])
    expect(result.done).toBe(3000)
    expect(result.met).toBe(true)
  })

  it('DOES count a transfer toward a savings goal', () => {
    // The mirror of the above: a savings transfer is exactly what this asks for.
    const result = goalProgress(
      { metric: 'save_at_least', target_amount: 10000, metric_category: 'Savings' },
      [{ type: 'credit', amount: 10000, category: 'Savings' }],
    )
    expect(result.done).toBe(10000)
  })

  it('scopes to the wallet when one is named', () => {
    const g = { metric: 'save_at_least', target_amount: 100, metric_wallet_id: 'w1' }
    const result = goalProgress(g, [
      { type: 'credit', amount: 60, wallet_id: 'w1' },
      { type: 'credit', amount: 40, wallet_id: 'w2' },
    ])
    expect(result.done).toBe(60)
  })

  it('ignores voided rows', () => {
    const result = goalProgress(saving, [
      { type: 'credit', amount: 5000, category: 'Savings' },
      { type: 'credit', amount: 5000, category: 'Savings', voided: true },
    ])
    expect(result.done).toBe(5000)
  })

  it('never divides by a zero target', () => {
    expect(goalProgress({ metric: 'save_at_least', target_amount: 0 }, []).share).toBe(0)
  })
})

describe('pace', () => {
  it('rounds the per-period figure UP', () => {
    // Three slices of ₦3,333 is ₦9,999 -- a plan that never quite arrives.
    const p = pace({ target_amount: 10000 }, { done: 0 }, 3)
    expect(p.perPeriod).toBe(3334)
  })

  it('raises the number when you fall behind, rather than shrinking the goal', () => {
    // The honest direction. A plan that adjusts downward every time you miss it
    // will always report success.
    const onSchedule = pace({ target_amount: 40000 }, { done: 20000 }, 2)
    const behind = pace({ target_amount: 40000 }, { done: 0 }, 2)
    expect(behind.perPeriod).toBeGreaterThan(onSchedule.perPeriod)
  })

  it('asks for nothing once the target is met or passed', () => {
    expect(pace({ target_amount: 100 }, { done: 100 }, 4).remaining).toBe(0)
    expect(pace({ target_amount: 100 }, { done: 250 }, 4).remaining).toBe(0)
  })

  it('survives a zero or missing period count', () => {
    expect(pace({ target_amount: 100 }, { done: 0 }, 0).perPeriod).toBe(100)
    expect(Number.isFinite(pace({ target_amount: 100 }, { done: 0 }, undefined).perPeriod)).toBe(true)
  })
})

describe('decomposeMonthly', () => {
  // target_date is the period the goal is FOR -- the 1st for a monthly goal --
  // not a free-form deadline. The deadline is derived as the end of that month,
  // which is what keeps (period, target_date, slot) meaning "one set of goals
  // per period" across all three cadences.
  const monthly = {
    id: 'm1',
    period: 'monthly',
    title: 'Laptop fund',
    target_date: '2026-08-01',
    metric: 'save_at_least',
    target_amount: 150000,
    metric_category: 'Savings',
  }

  it('derives its deadline from the month it is anchored to', () => {
    // Same answer whichever day of August the goal is anchored to, because the
    // month's end is what matters -- storing a deadline separately would let
    // the two disagree.
    const fromFirst = decomposeMonthly(monthly, { done: 0 }, '2026-08-10')
    const fromTenth = decomposeMonthly({ ...monthly, target_date: '2026-08-10' }, { done: 0 }, '2026-08-10')
    expect(fromFirst.target_amount).toBe(fromTenth.target_amount)
  })

  it('produces one weekly goal for the current week', () => {
    const row = decomposeMonthly(monthly, { done: 0 }, '2026-08-10')
    expect(row.period).toBe('weekly')
    expect(row.target_date).toBe('2026-08-10')
    expect(row.parent_id).toBe('m1')
    expect(row.generated).toBe(true)
    expect(row.slot).toBeGreaterThanOrEqual(GENERATED_SLOT_BASE)
  })

  it('divides by the weeks actually left, not by four', () => {
    // A goal created mid-month must not pretend the earlier weeks are still
    // available -- that understates every remaining week.
    const early = decomposeMonthly(monthly, { done: 0 }, '2026-08-03')
    const late = decomposeMonthly(monthly, { done: 0 }, '2026-08-24')
    expect(late.target_amount).toBeGreaterThan(early.target_amount)
  })

  it('says nothing once the goal is met', () => {
    // A task telling you to save money you have already saved is noise, and
    // noise teaches you to ignore the list.
    expect(decomposeMonthly(monthly, { done: 150000 }, '2026-08-10')).toBe(null)
  })

  it('ignores manual goals and non-monthly goals', () => {
    expect(decomposeMonthly({ ...monthly, metric: 'manual' }, { done: 0 }, '2026-08-10')).toBe(null)
    expect(decomposeMonthly({ ...monthly, period: 'weekly' }, { done: 0 }, '2026-08-10')).toBe(null)
    expect(decomposeMonthly(null, { done: 0 }, '2026-08-10')).toBe(null)
  })

  it('carries the metric down so the child can measure itself too', () => {
    const row = decomposeMonthly(monthly, { done: 0 }, '2026-08-10')
    expect(row.metric).toBe('save_at_least')
    expect(row.metric_category).toBe('Savings')
  })
})

describe('decomposeWeekly', () => {
  const weekly = {
    id: 'w1',
    period: 'weekly',
    title: 'Laptop fund',
    metric: 'save_at_least',
    target_amount: 35000,
    metric_category: 'Savings',
  }

  it('produces today’s task', () => {
    const row = decomposeWeekly(weekly, { done: 0 }, '2026-08-10')
    expect(row.period).toBe('daily')
    expect(row.target_date).toBe('2026-08-10')
    expect(row.parent_id).toBe('w1')
    expect(row.generated).toBe(true)
  })

  it('divides by days LEFT in the week, not by seven', () => {
    // Created on Friday, it must ask for a Friday-sized share rather than
    // pretending Monday is still available.
    const monday = decomposeWeekly(weekly, { done: 0 }, '2026-08-10')
    const friday = decomposeWeekly(weekly, { done: 0 }, '2026-08-14')
    expect(monday.target_amount).toBe(5000)
    expect(friday.target_amount).toBe(11667)
  })

  it('handles the last day of the week without dividing by zero', () => {
    const sunday = decomposeWeekly(weekly, { done: 0 }, '2026-08-16')
    expect(sunday.target_amount).toBe(35000)
    expect(Number.isFinite(sunday.target_amount)).toBe(true)
  })

  it('says nothing once the week’s target is met', () => {
    expect(decomposeWeekly(weekly, { done: 35000 }, '2026-08-12')).toBe(null)
  })
})

describe('reconcileGenerated', () => {
  /** A task derived from weekly goal `w1`, for Monday 10 August. */
  const candidate = {
    parent_id: 'w1',
    period: 'daily',
    target_date: '2026-08-10',
    title: 'Set aside ₦5,000 today',
    target_amount: 5000,
    generated: true,
  }

  const stored = (over = {}) => ({ ...candidate, id: 'g1', slot: 10, completed: false, ...over })

  it('writes a task that does not exist yet, in the generated slot range', () => {
    const { write } = reconcileGenerated([candidate], [])
    expect(write).toHaveLength(1)
    expect(write[0].slot).toBeGreaterThanOrEqual(GENERATED_SLOT_BASE)
  })

  it('updates an untouched task in place when its number changes', () => {
    const { write } = reconcileGenerated([candidate], [stored({ title: 'Set aside ₦4,000 today', target_amount: 4000 })])
    expect(write).toHaveLength(1)
    expect(write[0].id).toBe('g1')
    expect(write[0].slot).toBe(10)
  })

  it('writes nothing when nothing has changed', () => {
    // Generation runs on every page load. Without this, opening Daily HQ twice
    // costs a write that sets a row to the value it already holds.
    const { write, unchanged } = reconcileGenerated([candidate], [stored()])
    expect(write).toHaveLength(0)
    expect(unchanged).toHaveLength(1)
  })

  it('never unticks a completed task', () => {
    // Mirrors DailyHQ's priority upsert, which omits `completed` on purpose so
    // an edit cannot untick a ticked box.
    const { write, kept } = reconcileGenerated([candidate], [stored({ completed: true, target_amount: 1 })])
    expect(write).toHaveLength(0)
    expect(kept).toHaveLength(1)
  })

  it('never overwrites something a person typed', () => {
    const { write, kept } = reconcileGenerated([candidate], [
      stored({ generated: false, title: 'Buy mum a gift' }),
    ])
    expect(write).toHaveLength(0)
    expect(kept[0].title).toBe('Buy mum a gift')
  })

  // The bug this rewrite exists for. Keying on (period, target_date, slot) meant
  // slots were handed out by array position, so adding one goal renumbered the
  // rest and goal A's task landed on the row belonging to goal B -- rewriting
  // it, with no error anywhere.
  it('keeps each goal on its own row when another goal appears', () => {
    const fromW1 = { ...candidate, parent_id: 'w1', title: 'W1 task' }
    const fromW2 = { ...candidate, parent_id: 'w2', title: 'W2 task' }

    const first = reconcileGenerated([fromW1], [])
    const w1Slot = first.write[0].slot

    // Next run, a second goal exists and sorts ahead of it.
    const second = reconcileGenerated(
      [fromW2, fromW1],
      [{ ...fromW1, id: 'g1', slot: w1Slot, completed: false }],
    )

    const w1Row = second.write.concat(second.unchanged).find((r) => r.parent_id === 'w1')
    const w2Row = second.write.find((r) => r.parent_id === 'w2')

    expect(w1Row.slot).toBe(w1Slot)
    expect(w2Row.slot).not.toBe(w1Slot)
  })

  it('gives two new goals on the same day distinct slots', () => {
    const { write } = reconcileGenerated(
      [
        { ...candidate, parent_id: 'a' },
        { ...candidate, parent_id: 'b' },
      ],
      [],
    )
    expect(new Set(write.map((r) => r.slot)).size).toBe(2)
  })

  it('steps over a slot already taken by a hand-typed row', () => {
    const { write } = reconcileGenerated([candidate], [
      { period: 'daily', target_date: '2026-08-10', slot: 10, generated: false, title: 'mine' },
    ])
    expect(write[0].slot).toBeGreaterThan(10)
  })

  it('restarts numbering on a different day', () => {
    const { write } = reconcileGenerated(
      [
        { ...candidate, parent_id: 'a', target_date: '2026-08-10' },
        { ...candidate, parent_id: 'b', target_date: '2026-08-11' },
      ],
      [],
    )
    expect(write.map((r) => r.slot)).toEqual([GENERATED_SLOT_BASE, GENERATED_SLOT_BASE])
  })

  it('caps how many derived tasks land on one day', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...candidate, parent_id: `p${i}` }))
    expect(reconcileGenerated(many, []).write).toHaveLength(MAX_GENERATED_PER_DAY)
  })

  it('treats a different day as a different row', () => {
    const { write } = reconcileGenerated([candidate], [
      stored({ target_date: '2026-08-09', completed: true }),
    ])
    expect(write).toHaveLength(1)
  })

  it('survives nulls and missing arguments', () => {
    expect(reconcileGenerated([null, candidate], [null]).write).toHaveLength(1)
    expect(reconcileGenerated([candidate]).write).toHaveLength(1)
    expect(reconcileGenerated([], []).write).toHaveLength(0)
  })
})

describe('isTaskDone', () => {
  const saving = {
    metric: 'save_at_least',
    target_amount: 5000,
    metric_category: 'Savings',
    completed: false,
  }

  it('reads the checkbox for a task you typed', () => {
    expect(isTaskDone({ title: 'Call the bank', completed: true }, [])).toBe(true)
    expect(isTaskDone({ title: 'Call the bank', completed: false }, [])).toBe(false)
  })

  it('reads the ledger for a measured task, ignoring the checkbox', () => {
    // A measured task never has `completed` set -- the generator refuses to
    // write it -- so trusting the column would mark every one permanently
    // undone.
    expect(isTaskDone(saving, [{ type: 'credit', amount: 5000, category: 'Savings' }])).toBe(true)
    expect(isTaskDone(saving, [{ type: 'credit', amount: 4999, category: 'Savings' }])).toBe(false)
  })

  it('flips back when the transaction behind it is voided', () => {
    // The reason doneness is derived and not stored. A stored flag would leave
    // the task ticked after the money that satisfied it was struck off.
    const rows = [{ type: 'credit', amount: 5000, category: 'Savings' }]
    expect(isTaskDone(saving, rows)).toBe(true)
    expect(isTaskDone(saving, [{ ...rows[0], voided: true }])).toBe(false)
  })

  it('treats a task with no metric as manual', () => {
    // Every row written before migration 009 is this shape.
    expect(isTaskDone({ title: 'legacy', completed: true })).toBe(true)
  })

  it('survives being handed nothing', () => {
    expect(isTaskDone(null)).toBe(false)
    expect(isTaskDone({})).toBe(false)
  })
})
