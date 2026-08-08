import { describe, it, expect } from 'vitest'
import {
  outstanding,
  repaymentProgress,
  cycleStatus,
  daysUntil,
  upcomingDebts,
  debtTotals,
  isRotating,
} from '../src/lib/debts.js'

const NOW = new Date(2026, 7, 8) // 8 Aug 2026, local

describe('outstanding', () => {
  it('subtracts what has been paid', () => {
    expect(outstanding({ principal: 50000, amount_paid: 20000 })).toBe(30000)
  })

  it('never goes negative on an overpayment', () => {
    expect(outstanding({ principal: 10000, amount_paid: 12000 })).toBe(0)
  })

  it('handles missing fields', () => {
    expect(outstanding({})).toBe(0)
    expect(outstanding(null)).toBe(0)
  })
})

describe('repaymentProgress', () => {
  it('reports a fraction, capped at 1', () => {
    expect(repaymentProgress({ principal: 100, amount_paid: 25 })).toBe(0.25)
    expect(repaymentProgress({ principal: 100, amount_paid: 250 })).toBe(1)
  })

  it('returns null when there is nothing to measure', () => {
    expect(repaymentProgress({ principal: 0, amount_paid: 0 })).toBeNull()
  })
})

describe('cycleStatus', () => {
  // The whole reason the debts table exists: this cannot be derived from the
  // ledger, where twelve identical contributions look identical.
  it('describes where a 12-month ajo stands', () => {
    const s = cycleStatus({ kind: 'ajo', cycle_size: 12, cycle_position: 4, contribution: 20000 })

    expect(s.position).toBe(4)
    expect(s.roundsLeft).toBe(8)
    expect(s.contributed).toBe(80000)
    expect(s.expectedPot).toBe(240000)
  })

  it('applies to esusu too', () => {
    expect(cycleStatus({ kind: 'esusu', cycle_size: 6, cycle_position: 6, contribution: 5000 }).roundsLeft).toBe(0)
  })

  it('is not meaningful for a loan', () => {
    expect(cycleStatus({ kind: 'loan', cycle_size: 12, cycle_position: 4 })).toBeNull()
  })

  it('clamps a position outside the cycle instead of reporting nonsense', () => {
    expect(cycleStatus({ kind: 'ajo', cycle_size: 12, cycle_position: 99, contribution: 1 }).position).toBe(12)
    expect(cycleStatus({ kind: 'ajo', cycle_size: 12, cycle_position: 0, contribution: 1 }).position).toBe(1)
  })

  it('returns null without a cycle size', () => {
    expect(cycleStatus({ kind: 'ajo', contribution: 20000 })).toBeNull()
  })
})

describe('daysUntil', () => {
  it('counts forward, backward and today', () => {
    expect(daysUntil('2026-08-15', NOW)).toBe(7)
    expect(daysUntil('2026-08-08', NOW)).toBe(0)
    expect(daysUntil('2026-08-01', NOW)).toBe(-7)
  })

  it('handles missing or malformed dates', () => {
    expect(daysUntil(null, NOW)).toBeNull()
    expect(daysUntil('not a date', NOW)).toBeNull()
  })
})

describe('upcomingDebts', () => {
  const debts = [
    { id: 'a', kind: 'loan', direction: 'i_owe', due_date: '2026-08-10' },
    { id: 'b', kind: 'ajo', payout_date: '2026-08-12' },
    { id: 'c', kind: 'loan', direction: 'i_owe', due_date: '2026-09-30' }, // outside window
    { id: 'd', kind: 'loan', direction: 'i_owe', due_date: '2026-07-01' }, // overdue
    { id: 'e', kind: 'loan', direction: 'i_owe', due_date: '2026-08-09', settled: true },
  ]

  it('surfaces items inside the window, soonest first', () => {
    const items = upcomingDebts(debts, 7, NOW)
    expect(items.map((i) => i.debt.id)).toEqual(['d', 'a', 'b'])
  })

  // A payment missed last month should not quietly vanish because it fell out
  // of a forward-looking window.
  it('keeps overdue items visible however old', () => {
    const items = upcomingDebts(debts, 7, NOW)
    const overdue = items.find((i) => i.debt.id === 'd')
    expect(overdue.days).toBeLessThan(0)
  })

  it('excludes settled debts and anything beyond the window', () => {
    const ids = upcomingDebts(debts, 7, NOW).map((i) => i.debt.id)
    expect(ids).not.toContain('e')
    expect(ids).not.toContain('c')
  })

  it('labels payouts separately from payments due', () => {
    const items = upcomingDebts(debts, 7, NOW)
    expect(items.find((i) => i.debt.id === 'b').kind).toBe('payout')
    expect(items.find((i) => i.debt.id === 'a').kind).toBe('due')
  })

  it('reports both dates when one debt has each', () => {
    const items = upcomingDebts(
      [{ id: 'x', kind: 'ajo', due_date: '2026-08-09', payout_date: '2026-08-11' }],
      7,
      NOW,
    )
    expect(items.map((i) => i.kind)).toEqual(['due', 'payout'])
  })
})

describe('debtTotals', () => {
  it('separates the two directions and rotating contributions', () => {
    const t = debtTotals([
      { kind: 'loan', direction: 'i_owe', principal: 50000, amount_paid: 10000 },
      { kind: 'loan', direction: 'owed_to_me', principal: 15000, amount_paid: 0 },
      { kind: 'ajo', cycle_size: 12, cycle_position: 3, contribution: 20000 },
    ])

    expect(t.iOwe).toBe(40000)
    expect(t.owedToMe).toBe(15000)
    // Contributed so far, not the pot: the money is saved, not owed.
    expect(t.inCycles).toBe(60000)
  })

  it('ignores settled debts', () => {
    const t = debtTotals([
      { kind: 'loan', direction: 'i_owe', principal: 50000, amount_paid: 0, settled: true },
    ])
    expect(t.iOwe).toBe(0)
  })

  it('handles an empty list', () => {
    expect(debtTotals([])).toEqual({ iOwe: 0, owedToMe: 0, inCycles: 0 })
    expect(debtTotals(null).iOwe).toBe(0)
  })
})

describe('isRotating', () => {
  it('covers ajo and esusu only', () => {
    expect(isRotating('ajo')).toBe(true)
    expect(isRotating('esusu')).toBe(true)
    expect(isRotating('loan')).toBe(false)
  })
})
