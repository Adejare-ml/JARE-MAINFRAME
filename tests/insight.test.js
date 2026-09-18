import { describe, it, expect } from 'vitest'
import { dailyInsight } from '../src/lib/insight.js'

describe('dailyInsight', () => {
  it('falls back to a neutral line when nothing else applies', () => {
    // safeToSpendToday defaults to 0, which is itself a "watch" case (see
    // below) -- give it real headroom so nothing earlier in the list fires.
    expect(dailyInsight({ safeToSpendToday: 5000 }).tone).toBe('neutral')
    expect(dailyInsight({ safeToSpendToday: 5000 }).text).toMatch(/clean slate/i)
  })

  it('defaults to the same "nothing safe to spend" watch case with no facts at all', () => {
    expect(dailyInsight().tone).toBe('watch')
  })

  it('leads with a low wallet balance above everything else', () => {
    const result = dailyInsight({
      lowWallets: [{ name: 'GTBank', balance: 1500 }],
      overdueDebts: [{ debt: { counterparty: 'Chidi' }, days: -3 }],
      totalSpent: 200000,
      budgetTarget: 50000,
    })
    expect(result.text).toContain('GTBank')
    expect(result.text).toContain('running low')
    expect(result.tone).toBe('warn')
  })

  it('names an overdue debt when no wallet is low', () => {
    const result = dailyInsight({
      overdueDebts: [{ debt: { counterparty: 'Chidi' }, days: -3 }],
      totalSpent: 200000,
      budgetTarget: 50000,
    })
    expect(result.text).toContain('Chidi')
    expect(result.text).toContain('3 days overdue')
    expect(result.tone).toBe('warn')
  })

  it('singularises a one-day overdue debt', () => {
    const result = dailyInsight({
      overdueDebts: [{ debt: { counterparty: 'Chidi' }, days: -1 }],
    })
    expect(result.text).toContain('1 day overdue')
  })

  it('flags an already-blown budget before pace', () => {
    const result = dailyInsight({ totalSpent: 60000, budgetTarget: 50000, pace: { aheadBy: 0, onTrack: true } })
    expect(result.text).toMatch(/over this month's budget/)
    expect(result.tone).toBe('warn')
  })

  it('flags running ahead of pace when still under the total budget', () => {
    const result = dailyInsight({
      totalSpent: 40000,
      budgetTarget: 60000,
      pace: { aheadBy: 15000, onTrack: false },
    })
    expect(result.text).toMatch(/ahead of pace/)
    expect(result.tone).toBe('watch')
  })

  it('celebrates a real streak once nothing more urgent is true', () => {
    const result = dailyInsight({ streak: 5, safeToSpendToday: 10000 })
    expect(result.text).toContain('5-day streak')
    expect(result.tone).toBe('good')
  })

  it('warns when there is nothing left safe to spend', () => {
    const result = dailyInsight({ streak: 0, safeToSpendToday: 0 })
    expect(result.text).toMatch(/nothing safe to spend/i)
    expect(result.tone).toBe('watch')
  })

  it('reports on-pace-and-on-budget as the good case', () => {
    const result = dailyInsight({
      budgetTarget: 60000,
      totalSpent: 20000,
      pace: { aheadBy: -5000, onTrack: true },
      safeToSpendToday: 15000,
    })
    expect(result.text).toMatch(/on pace/i)
    expect(result.tone).toBe('good')
  })

  it('ranks a low balance above a blown budget and a streak', () => {
    const result = dailyInsight({
      lowWallets: [{ name: 'Opay', balance: 200 }],
      totalSpent: 90000,
      budgetTarget: 50000,
      streak: 10,
    })
    expect(result.text).toContain('Opay')
  })
})
