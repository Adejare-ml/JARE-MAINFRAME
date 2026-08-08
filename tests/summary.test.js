import { describe, it, expect } from 'vitest'
import {
  summarizeMonth,
  breakdownRows,
  runway,
  isKnownCategory,
  TRANSFER_CATEGORIES,
} from '../src/lib/summary.js'

const LIQUID = new Set(['gt', 'opay', 'cash'])

describe('summarizeMonth', () => {
  it('sums ordinary income and spending', () => {
    const s = summarizeMonth(
      [
        { type: 'credit', amount: 150000, category: 'Cash Received' /* excluded */, wallet_id: 'gt' },
        { type: 'credit', amount: 200000, category: 'Uncategorized', wallet_id: 'gt' },
        { type: 'debit', amount: 2600, category: 'Transport', wallet_id: 'opay' },
        { type: 'debit', amount: 12000, category: 'Feeding / Groceries', wallet_id: 'gt' },
      ],
      LIQUID,
    )

    expect(s.income).toBe(200000)
    expect(s.spent).toBe(14600)
  })

  // The headline bug: moving money to PiggyVest read as spending it, because
  // the old exclusion looked at the wallet, and the debit leg of a transfer
  // sits on the liquid side.
  it('does not count a savings transfer as spending', () => {
    const s = summarizeMonth(
      [{ type: 'debit', amount: 50000, category: 'Savings Transfer', wallet_id: 'gt' }],
      LIQUID,
    )

    expect(s.spent).toBe(0)
    expect(s.movedAside).toBe(50000)
  })

  // ATM cash: withdrawal debit + reconciliation credit. Old code counted the
  // withdrawal as spending AND the received cash as income.
  it('counts an ATM withdrawal once as moved-aside, never as income or spending', () => {
    const s = summarizeMonth(
      [
        { type: 'debit', amount: 20000, category: 'Cash Withdrawal', wallet_id: 'gt' },
        { type: 'credit', amount: 20000, category: 'Cash Received', wallet_id: 'cash' },
        { type: 'debit', amount: 3000, category: 'Feeding / Groceries', wallet_id: 'cash' },
      ],
      LIQUID,
    )

    expect(s.income).toBe(0)
    expect(s.spent).toBe(3000)
    expect(s.movedAside).toBe(20000) // once, not 40000
  })

  it('ignores non-liquid wallets but keeps unassigned rows', () => {
    const s = summarizeMonth(
      [
        { type: 'debit', amount: 9000, category: 'Transport', wallet_id: 'piggyvest' },
        { type: 'debit', amount: 500, category: 'Transport' /* legacy: no wallet_id */ },
      ],
      LIQUID,
    )

    expect(s.spent).toBe(500)
  })

  it('groups spending by category, largest first', () => {
    const s = summarizeMonth(
      [
        { type: 'debit', amount: 100, category: 'Transport', wallet_id: 'gt' },
        { type: 'debit', amount: 900, category: 'Rent', wallet_id: 'gt' },
        { type: 'debit', amount: 200, category: 'Transport', wallet_id: 'gt' },
      ],
      LIQUID,
    )

    expect(s.byCategory).toEqual([
      { category: 'Rent', total: 900 },
      { category: 'Transport', total: 300 },
    ])
  })

  it('handles empty and malformed input', () => {
    expect(summarizeMonth([], LIQUID).spent).toBe(0)
    expect(summarizeMonth(null, LIQUID).income).toBe(0)
    expect(summarizeMonth([{ type: 'debit', amount: 'NaN', wallet_id: 'gt' }], LIQUID).spent).toBe(0)
  })

  // If a transfer category is ever renamed in constants.js, this fails rather
  // than the exclusion silently matching nothing.
  it('excludes only categories that actually exist', () => {
    for (const c of TRANSFER_CATEGORIES) {
      expect(isKnownCategory(c)).toBe(true)
    }
  })
})

describe('breakdownRows', () => {
  it('computes shares and folds small categories into Other', () => {
    const rows = breakdownRows([
      { category: 'Rent', total: 70 },
      { category: 'Transport', total: 28 },
      { category: 'Bank Charges', total: 2 }, // 2% -> Other
    ])

    expect(rows.map((r) => r.category)).toEqual(['Rent', 'Transport', 'Other'])
    expect(rows[0].share).toBeCloseTo(0.7)
    expect(rows[2].total).toBe(2)
  })

  it('returns nothing for an empty month', () => {
    expect(breakdownRows([])).toEqual([])
    expect(breakdownRows(null)).toEqual([])
  })
})

describe('runway', () => {
  it('holds back for the first two days of the month', () => {
    // One airtime purchase on the 1st is not a burn rate.
    expect(runway(100000, 500, 1)).toBeNull()
    expect(runway(100000, 500, 2)).toBeNull()
    expect(runway(100000, 500, 3)).not.toBeNull()
  })

  it('computes days from the month-to-date average', () => {
    const r = runway(90000, 30000, 10) // 3000/day
    expect(r.dailyBurn).toBe(3000)
    expect(r.daysOfRunway).toBe(30)
    expect(r.capped).toBe(false)
  })

  it('caps at 90 days and says so', () => {
    const r = runway(1000000, 1000, 10)
    expect(r.daysOfRunway).toBe(90)
    expect(r.capped).toBe(true)
  })

  it('reports zero burn as no-number rather than infinity', () => {
    expect(runway(50000, 0, 15).daysOfRunway).toBeNull()
  })

  it('never returns negative days', () => {
    expect(runway(-5000, 3000, 10).daysOfRunway).toBe(0)
  })
})
