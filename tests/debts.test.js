import { describe, it, expect } from 'vitest'
import {
  outstanding,
  repaymentProgress,
  cycleStatus,
  daysUntil,
  upcomingDebts,
  debtTotals,
  isRotating,
  payoffProjection,
  repayingType,
  linkedPayments,
  paidTotal,
  paidTotals,
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

describe('payoffProjection', () => {
  it('does not divide by zero on a zero (or missing) payment', () => {
    expect(payoffProjection({ principal: 50000, amount_paid: 0 }, 0, NOW)).toBeNull()
    expect(payoffProjection({ principal: 50000, amount_paid: 0 }, null, NOW)).toBeNull()
    expect(payoffProjection({ principal: 50000, amount_paid: 0 }, undefined, NOW)).toBeNull()
  })

  it('returns immediately for an already-paid-off debt, regardless of payment', () => {
    expect(payoffProjection({ principal: 50000, amount_paid: 50000 }, 5000, NOW)).toEqual({
      monthsRemaining: 0,
      payoffDate: '2026-08-08',
    })
    // Even with no payment supplied -- there is nothing left to project.
    expect(payoffProjection({ principal: 50000, amount_paid: 50000 }, 0, NOW)).toEqual({
      monthsRemaining: 0,
      payoffDate: '2026-08-08',
    })
  })

  it('rounds up to the month a partial final payment falls in', () => {
    // ₦30,000 left at ₦12,000/month: two full months clears ₦24,000, a third
    // month covers the remaining ₦6,000 -- three months, not two-and-a-half.
    const result = payoffProjection({ principal: 30000, amount_paid: 0 }, 12000, NOW)
    expect(result.monthsRemaining).toBe(3)
  })

  it('projects the calendar date the months land on', () => {
    const result = payoffProjection({ principal: 30000, amount_paid: 0 }, 10000, NOW)
    expect(result.monthsRemaining).toBe(3)
    expect(result.payoffDate).toBe('2026-11-08')
  })

  it('never goes negative -- an overpaid debt is zero months, not a negative one', () => {
    expect(payoffProjection({ principal: 10000, amount_paid: 20000 }, 5000, NOW).monthsRemaining).toBe(0)
  })

  it('survives missing input', () => {
    expect(payoffProjection({}, 5000, NOW)).toEqual({ monthsRemaining: 0, payoffDate: '2026-08-08' })
    expect(payoffProjection(null, 5000, NOW)).toEqual({ monthsRemaining: 0, payoffDate: '2026-08-08' })
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

describe('repayingType', () => {
  it('is money out for what I owe, money in for what is owed to me', () => {
    expect(repayingType({ direction: 'i_owe' })).toBe('debit')
    expect(repayingType({ direction: 'owed_to_me' })).toBe('credit')
  })

  it('defaults to money out', () => {
    expect(repayingType({})).toBe('debit')
    expect(repayingType(null)).toBe('debit')
  })
})

describe('linkedPayments', () => {
  const debt = { id: 'd1', direction: 'i_owe', principal: 50000, amount_paid: 5000 }
  const rows = [
    { id: 't1', debt_id: 'd1', type: 'debit', amount: 10000, voided: false },
    { id: 't2', debt_id: 'd1', type: 'debit', amount: 2500, voided: true }, // voided: does not count
    { id: 't3', debt_id: 'd1', type: 'credit', amount: 999, voided: false }, // wrong direction
    { id: 't4', debt_id: 'd2', type: 'debit', amount: 7000, voided: false }, // another debt
    { id: 't5', debt_id: null, type: 'debit', amount: 7000 }, // unlinked
    { id: 't6', debt_id: 'd1', type: 'debit', amount: 3000 }, // voided column absent (pre-006)
  ]

  it('keeps only this debt, the repaying direction, and rows not voided', () => {
    expect(linkedPayments(rows, debt).map((r) => r.id)).toEqual(['t1', 't6'])
  })

  it('flips direction for money owed to me', () => {
    const owed = { id: 'd1', direction: 'owed_to_me' }
    expect(linkedPayments(rows, owed).map((r) => r.id)).toEqual(['t3'])
  })

  it('is empty without a debt id or rows', () => {
    expect(linkedPayments(rows, {})).toEqual([])
    expect(linkedPayments(null, debt)).toEqual([])
  })
})

describe('paidTotal', () => {
  const debt = { id: 'd1', direction: 'i_owe', principal: 50000, amount_paid: 5000 }

  it('adds linked repayments on top of the typed baseline', () => {
    const rows = [
      { debt_id: 'd1', type: 'debit', amount: 10000 },
      { debt_id: 'd1', type: 'debit', amount: '2500' },
    ]
    expect(paidTotal(debt, rows)).toBe(17500)
  })

  // The whole reason the total is derived rather than stored: undoing a
  // payment is one flag on the row, not a reversal branch somewhere else.
  it('un-counts a voided payment with no other write', () => {
    const before = [{ debt_id: 'd1', type: 'debit', amount: 10000, voided: false }]
    const after = [{ debt_id: 'd1', type: 'debit', amount: 10000, voided: true }]
    expect(paidTotal(debt, before)).toBe(15000)
    expect(paidTotal(debt, after)).toBe(5000)
  })

  it('is the baseline alone with no rows -- a database behind 029', () => {
    expect(paidTotal(debt)).toBe(5000)
    expect(paidTotal(debt, [])).toBe(5000)
    expect(paidTotal({ id: 'x' }, [])).toBe(0)
  })

  it('keys every debt at once', () => {
    const rows = [
      { debt_id: 'a', type: 'debit', amount: 100 },
      { debt_id: 'b', type: 'credit', amount: 40 },
    ]
    expect(
      paidTotals(
        [
          { id: 'a', direction: 'i_owe', amount_paid: 1 },
          { id: 'b', direction: 'owed_to_me', amount_paid: 2 },
          { id: 'c', direction: 'i_owe' },
        ],
        rows,
      ),
    ).toEqual({ a: 101, b: 42, c: 0 })
    expect(paidTotals(null, rows)).toEqual({})
  })
})

describe('the paid override', () => {
  const debt = { id: 'd1', direction: 'i_owe', principal: 50000, amount_paid: 5000 }

  it('replaces amount_paid in outstanding and progress when supplied', () => {
    expect(outstanding(debt)).toBe(45000)
    expect(outstanding(debt, 20000)).toBe(30000)
    expect(outstanding(debt, 60000)).toBe(0)
    expect(repaymentProgress(debt)).toBe(0.1)
    expect(repaymentProgress(debt, 25000)).toBe(0.5)
  })

  it('treats null and undefined as "not supplied", and zero as zero', () => {
    expect(outstanding(debt, null)).toBe(45000)
    expect(outstanding(debt, undefined)).toBe(45000)
    expect(outstanding(debt, 0)).toBe(50000)
  })

  it('moves the payoff date with what the ledger says was paid', () => {
    const typed = payoffProjection(debt, 10000, NOW)
    const derived = payoffProjection(debt, 10000, NOW, 45000)
    expect(typed.monthsRemaining).toBe(5)
    expect(derived.monthsRemaining).toBe(1)
    expect(payoffProjection(debt, 10000, NOW, 50000).monthsRemaining).toBe(0)
  })

  it('flows into the totals row through a paid map', () => {
    const debts = [
      { id: 'a', kind: 'loan', direction: 'i_owe', principal: 50000, amount_paid: 10000 },
      { id: 'b', kind: 'loan', direction: 'owed_to_me', principal: 15000, amount_paid: 0 },
    ]
    expect(debtTotals(debts)).toMatchObject({ iOwe: 40000, owedToMe: 15000 })
    expect(debtTotals(debts, { a: 30000, b: 15000 })).toMatchObject({ iOwe: 20000, owedToMe: 0 })
    // A debt missing from the map keeps its typed figure.
    expect(debtTotals(debts, { a: 30000 })).toMatchObject({ iOwe: 20000, owedToMe: 15000 })
  })
})
