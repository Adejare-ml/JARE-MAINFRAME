import { describe, it, expect } from 'vitest'
import { buildMonthRecap, describeChange } from '../src/lib/monthRecap.js'

const d = (amount, category, extra = {}) => ({ type: 'debit', amount, category, wallet_id: 'w', ...extra })
const c = (amount, category = 'Salary') => ({ type: 'credit', amount, category, wallet_id: 'w' })
const text = (s) => s.map((x) => x.text).join(' ')

describe('describeChange', () => {
  it('words a rise, a fall, a flat month and no comparison', () => {
    expect(describeChange(120, 100)).toBe('up 20% on last month')
    expect(describeChange(80, 100)).toBe('down 20% on last month')
    expect(describeChange(101, 100)).toBe('about the same as last month')
    expect(describeChange(100, 0)).toBeNull()
  })
})

describe('buildMonthRecap', () => {
  it('is empty for a month with nothing in it', () => {
    expect(buildMonthRecap({ thisMonth: [] })).toEqual([])
  })

  it('states spend against last month, income and what stayed, and the biggest line', () => {
    const out = buildMonthRecap({
      label: 'September 2026',
      thisMonth: [d(30000, 'Transport'), d(20000, 'Feeding / Groceries'), c(100000)],
      lastMonth: [d(25000, 'Transport'), d(20000, 'Feeding / Groceries'), c(100000)],
    })
    expect(out.map((s) => s.key)).toEqual(['spent', 'income', 'top'])
    expect(out[0].text).toBe('September 2026: ₦50,000 spent, up 11% on last month.')
    expect(out[1].text).toBe('₦100,000 came in (about the same as last month); ₦50,000 of it stayed.')
    expect(out[2].text).toBe('Biggest line: Transport at ₦30,000, up 20% on last month.')
  })

  it('names the category that moved most, the burst envelopes, savings and refunds', () => {
    const out = buildMonthRecap({
      thisMonth: [d(30000, 'Transport'), d(16000, 'Dining Out'), d(12000, 'Transfer Out'), d(9000, 'Subscriptions')],
      lastMonth: [d(30000, 'Transport'), d(4000, 'Dining Out')],
      budgetByCategory: { 'Dining Out': 10000, Subscriptions: 5000, Transport: 50000 },
      refundsNetted: 2500,
    })
    expect(text(out)).toContain('Dining Out rose by ₦12,000.')
    expect(text(out)).toContain('Over budget: Dining Out (₦6,000 over), Subscriptions (₦4,000 over).')
    expect(text(out)).toContain('₦12,000 moved to savings or between your accounts.')
    expect(text(out)).toContain('₦2,500 came back as refunds and is left out of both sides.')
  })

  it('says when more went out than came in', () => {
    const out = buildMonthRecap({ thisMonth: [d(70000, 'Rent'), c(50000)] })
    expect(out.find((s) => s.key === 'income').text).toContain('₦20,000 more went out than came in')
  })
})
