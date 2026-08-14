import { describe, it, expect } from 'vitest'
import { spendByWeekday, compareWeeks, carriedOver, WEEKDAY_LABELS } from '../src/lib/weekreview.js'

/** Week of Monday 10 August 2026 through Sunday the 16th. */
const MONDAY = '2026-08-10'
const THURSDAY = '2026-08-13'

const debit = (date, amount, category = 'Transport') => ({
  transaction_date: date,
  type: 'debit',
  amount,
  category,
})

describe('spendByWeekday', () => {
  it('returns seven days, Monday first', () => {
    const days = spendByWeekday([], null, MONDAY, THURSDAY)
    expect(days).toHaveLength(7)
    expect(days.map((d) => d.label)).toEqual(WEEKDAY_LABELS)
    expect(days[0].date).toBe(MONDAY)
    expect(days[6].date).toBe('2026-08-16')
  })

  it('buckets spending onto the right day', () => {
    const days = spendByWeekday(
      [debit(MONDAY, 1000), debit(MONDAY, 500), debit(THURSDAY, 2000)],
      null,
      MONDAY,
      THURSDAY,
    )
    expect(days[0].spent).toBe(1500)
    expect(days[3].spent).toBe(2000)
    expect(days[1].spent).toBe(0)
  })

  it('excludes transfers, exactly as the month card does', () => {
    // A PiggyVest transfer writes a debit on GTBank. Counting it here but not
    // in the month total is how two cards on the same screen disagree.
    const days = spendByWeekday(
      [debit(MONDAY, 50000, 'Savings Transfer'), debit(MONDAY, 800, 'Feeding / Groceries')],
      null,
      MONDAY,
      THURSDAY,
    )
    expect(days[0].spent).toBe(800)
  })

  it('ignores credits', () => {
    const rows = [{ transaction_date: MONDAY, type: 'credit', amount: 90000, category: 'Salary' }]
    expect(spendByWeekday(rows, null, MONDAY, THURSDAY)[0].spent).toBe(0)
  })

  it('marks days after today as future', () => {
    // Friday onward has not happened; drawing a zero bar for it reads as "you
    // spent nothing" rather than "it is not Friday yet".
    const days = spendByWeekday([], null, MONDAY, THURSDAY)
    expect(days[3].isFuture).toBe(false)
    expect(days[3].isToday).toBe(true)
    expect(days[4].isFuture).toBe(true)
    expect(days[6].isFuture).toBe(true)
  })

  it('respects the liquid wallet filter', () => {
    const rows = [
      { ...debit(MONDAY, 1000), wallet_id: 'liquid' },
      { ...debit(MONDAY, 9999), wallet_id: 'savings' },
    ]
    expect(spendByWeekday(rows, new Set(['liquid']), MONDAY, THURSDAY)[0].spent).toBe(1000)
  })
})

describe('compareWeeks', () => {
  it('reports spending down as better and up as worse', () => {
    // The sign alone cannot say this: less spending is good news, less income
    // is not, and a caller reading only the sign colours half of them wrong.
    const down = compareWeeks([debit(MONDAY, 400)], [debit(MONDAY, 1000)], null)
    expect(down.spent.delta).toBe(-600)
    expect(down.spent.better).toBe(true)

    const up = compareWeeks([debit(MONDAY, 1500)], [debit(MONDAY, 1000)], null)
    expect(up.spent.better).toBe(false)
  })

  it('reports income up as better', () => {
    const credit = (amount) => ({ transaction_date: MONDAY, type: 'credit', amount, category: 'Salary' })
    const result = compareWeeks([credit(5000)], [credit(1000)], null)
    expect(result.income.delta).toBe(4000)
    expect(result.income.better).toBe(true)
  })

  it('refuses to compute a share against a zero baseline', () => {
    // "Up 100%" from nothing is a division that completed, not a fact.
    const result = compareWeeks([debit(MONDAY, 500)], [], null)
    expect(result.spent.share).toBe(null)
    expect(result.spent.delta).toBe(500)
  })

  it('computes a share when there is something to compare against', () => {
    const result = compareWeeks([debit(MONDAY, 1500)], [debit(MONDAY, 1000)], null)
    expect(result.spent.share).toBeCloseTo(0.5)
  })

  it('calls an unchanged figure neither better nor worse', () => {
    const result = compareWeeks([debit(MONDAY, 1000)], [debit(MONDAY, 1000)], null)
    expect(result.spent.delta).toBe(0)
    expect(result.spent.better).toBe(null)
  })

  it('carries the category breakdown for the current week only', () => {
    const result = compareWeeks(
      [debit(MONDAY, 1000, 'Transport')],
      [debit(MONDAY, 9999, 'Rent')],
      null,
    )
    expect(result.byCategory.map((c) => c.category)).toEqual(['Transport'])
  })

  it('handles two empty weeks without dividing by zero', () => {
    const result = compareWeeks([], [], null)
    expect(result.spent).toEqual({ now: 0, before: 0, delta: 0, share: null, better: null })
  })
})

describe('carriedOver', () => {
  const done = (g) => Boolean(g.completed)

  it('names what was left unfinished', () => {
    // A weekly target that vanishes on Monday teaches you the targets do not
    // mean anything.
    const goals = [
      { id: 'a', title: 'Save ₦20,000', completed: false },
      { id: 'b', title: 'Clear the Opay backlog', completed: true },
    ]
    expect(carriedOver(goals, done).map((g) => g.id)).toEqual(['a'])
  })

  it('is empty when the week was finished', () => {
    expect(carriedOver([{ completed: true }], done)).toEqual([])
  })

  it('survives nulls and missing input', () => {
    expect(carriedOver(null, done)).toEqual([])
    expect(carriedOver([null, { completed: false }], done)).toHaveLength(1)
  })
})
