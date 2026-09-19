import { describe, it, expect } from 'vitest'
import { buildWeekFacts, buildRecapPrompt, RECAP_SYSTEM_PROMPT } from '../src/lib/recapPrompt.js'

describe('RECAP_SYSTEM_PROMPT', () => {
  it('demands an exact citation and forbids invented numbers', () => {
    expect(RECAP_SYSTEM_PROMPT).toMatch(/cites/)
    expect(RECAP_SYSTEM_PROMPT).toMatch(/EXACTLY/)
    expect(RECAP_SYSTEM_PROMPT).toMatch(/number/)
  })

  it('allows an empty recap as a legitimate answer', () => {
    expect(RECAP_SYSTEM_PROMPT).toMatch(/\{"sentences": \[\]\}/)
  })
})

describe('buildWeekFacts', () => {
  const comparison = {
    spent: { now: 45231.5, before: 40384, delta: 4847.5, share: 0.12 },
    income: { now: 150000, before: 150000, delta: 0, share: 0 },
    movedAside: { now: 20000, before: 0, delta: 20000, share: null },
    byCategory: [
      { category: 'Transport', total: 8000 },
      { category: 'Feeding / Groceries', total: 15000 },
    ],
  }

  it('states this week\'s spend and the change from last week', () => {
    const facts = buildWeekFacts({ comparison })
    const spent = facts.find((f) => f.key === 'spent')
    expect(spent.numbers).toEqual([45231.5, 40384, 12])
    expect(spent.text).toContain('₦45,231.50')
    expect(spent.text).toContain('up 12%')
  })

  it('omits the comparison when last week was zero', () => {
    const facts = buildWeekFacts({
      comparison: { ...comparison, spent: { now: 5000, before: 0, delta: 5000, share: null } },
    })
    const spent = facts.find((f) => f.key === 'spent')
    expect(spent.numbers).toEqual([5000])
    expect(spent.text).not.toContain('from')
  })

  it('says down rather than up when spending fell', () => {
    const facts = buildWeekFacts({
      comparison: { ...comparison, spent: { now: 20000, before: 40000, delta: -20000, share: -0.5 } },
    })
    expect(facts.find((f) => f.key === 'spent').text).toContain('down 50%')
  })

  it('includes movedAside only when something actually moved', () => {
    const withMove = buildWeekFacts({ comparison })
    expect(withMove.some((f) => f.key === 'movedAside')).toBe(true)

    const withoutMove = buildWeekFacts({
      comparison: { ...comparison, movedAside: { now: 0, before: 0, delta: 0, share: null } },
    })
    expect(withoutMove.some((f) => f.key === 'movedAside')).toBe(false)
  })

  it('caps category facts and skips zero totals', () => {
    const facts = buildWeekFacts({
      comparison: {
        ...comparison,
        byCategory: [
          { category: 'A', total: 100 },
          { category: 'B', total: 90 },
          { category: 'C', total: 80 },
          { category: 'D', total: 70 },
          { category: 'E', total: 0 },
        ],
      },
    })
    const categoryFacts = facts.filter((f) => f.key.startsWith('category:'))
    expect(categoryFacts).toHaveLength(3)
    expect(categoryFacts.map((f) => f.key)).toEqual(['category:A', 'category:B', 'category:C'])
  })

  it('includes a streak fact only when there is a streak', () => {
    expect(buildWeekFacts({ comparison, streak: 0 }).some((f) => f.key === 'streak')).toBe(false)
    const facts = buildWeekFacts({ comparison, streak: 5 })
    const streak = facts.find((f) => f.key === 'streak')
    expect(streak.numbers).toEqual([5])
    expect(streak.text).toContain('5 days')
  })

  it('includes only measured weekly goals, done and target as the authorized numbers', () => {
    const facts = buildWeekFacts({
      comparison,
      weeklyGoals: [
        { id: 'g1', title: 'Save for rent', measured: true, done: 20000, target: 50000 },
        { id: 'g2', title: 'Tick manually', measured: false, done: 0, target: 0 },
      ],
    })
    const goal1 = facts.find((f) => f.key === 'goal:g1')
    expect(goal1.numbers).toEqual([20000, 50000])
    expect(facts.some((f) => f.key === 'goal:g2')).toBe(false)
  })

  it('returns nothing for a week with no comparison at all', () => {
    expect(buildWeekFacts({})).toEqual([])
    expect(buildWeekFacts()).toEqual([])
  })

  it('omits spent and income when nothing was spent or earned, not just when the whole comparison is missing', () => {
    // A zero-value fact ("spent ₦0.00 this week") is filler no different
    // from what the movedAside guard already catches -- without this, a
    // genuinely quiet week never actually produced an empty facts array,
    // which left the "nothing measurable" fast path in weekly-recap.mjs dead.
    const facts = buildWeekFacts({
      comparison: {
        spent: { now: 0, before: 0, delta: 0, share: null },
        income: { now: 0, before: 0, delta: 0, share: null },
        movedAside: { now: 0, before: 0, delta: 0, share: null },
        byCategory: [],
      },
      streak: 0,
    })
    expect(facts).toEqual([])
  })

  it('says "same as last week" rather than "up 0%" when spend is unchanged', () => {
    const facts = buildWeekFacts({
      comparison: { ...comparison, spent: { now: 40384, before: 40384, delta: 0, share: 0 } },
    })
    const spent = facts.find((f) => f.key === 'spent')
    expect(spent.text).toContain('same as last week')
    expect(spent.text).not.toContain('up 0%')
  })

  it('says "same as last week" rather than "up 0%" when income is unchanged', () => {
    // The default fixture's income (now: before: 150000) already exercises
    // this path -- assert it directly rather than incidentally.
    const facts = buildWeekFacts({ comparison })
    const income = facts.find((f) => f.key === 'income')
    expect(income.text).toContain('same as last week')
    expect(income.text).not.toContain('up 0%')
  })
})

describe('buildRecapPrompt', () => {
  it('lists every fact by key, exactly as reviewRecap will expect it cited', () => {
    const facts = [
      { key: 'spent', text: 'Spent ₦45,231.50 this week.' },
      { key: 'streak', text: '3 days logged in a row.' },
    ]
    const prompt = buildRecapPrompt(facts)
    expect(prompt).toContain('- spent: Spent ₦45,231.50 this week.')
    expect(prompt).toContain('- streak: 3 days logged in a row.')
  })

  it('states plainly when there is nothing to cite, rather than an empty section', () => {
    const prompt = buildRecapPrompt([])
    expect(prompt).toMatch(/none — nothing measurable happened/)
  })
})
