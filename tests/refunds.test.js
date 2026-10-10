import { describe, it, expect } from 'vitest'
import { matchRefunds, excludeRefunded, REFUND_WINDOW_DAYS } from '../src/lib/refunds.js'

const row = (id, type, amount, date, extra = {}) => ({
  id, type, amount, transaction_date: date, wallet_id: 'w1', category: 'Clothing & Fashion', recipient: 'JUMIA', ...extra,
})

describe('matchRefunds', () => {
  it('pairs a credit that says refund with the equal debit before it', () => {
    const rows = [row('d', 'debit', 15000, '2026-10-01'), row('c', 'credit', 15000, '2026-10-04', { recipient: '', description: 'REFUND JUMIA ORDER' })]
    const m = matchRefunds(rows)
    expect(m).toHaveLength(1)
    expect(m[0].debit.id).toBe('d')
    expect(m[0].reason).toBe('text')
  })

  it('pairs on a shared payee word when the narration does not say refund', () => {
    const rows = [row('d', 'debit', 2000, '2026-10-01', { recipient: 'BOLT RIDE' }), row('c', 'credit', 2000, '2026-10-02', { recipient: 'BOLT' })]
    expect(matchRefunds(rows)[0]?.reason).toBe('payee')
  })

  it('refuses equal amounts with nothing else in common, other wallets, or a credit before the debit', () => {
    expect(matchRefunds([row('d', 'debit', 5000, '2026-10-01', { recipient: 'FRIEND' }), row('c', 'credit', 5000, '2026-10-03', { recipient: 'CLIENT' })])).toEqual([])
    expect(matchRefunds([row('d', 'debit', 5000, '2026-10-01'), row('c', 'credit', 5000, '2026-10-03', { wallet_id: 'w2', description: 'refund' })])).toEqual([])
    expect(matchRefunds([row('c', 'credit', 5000, '2026-09-30', { description: 'refund' }), row('d', 'debit', 5000, '2026-10-01')])).toEqual([])
  })

  it('stops looking after the window and never touches transfers or voided rows', () => {
    const late = `2026-10-${String(1 + REFUND_WINDOW_DAYS + 1).padStart(2, '0')}`
    expect(matchRefunds([row('d', 'debit', 5000, '2026-10-01'), row('c', 'credit', 5000, late, { description: 'refund' })])).toEqual([])
    expect(matchRefunds([row('d', 'debit', 5000, '2026-10-01', { category: 'Transfer Out' }), row('c', 'credit', 5000, '2026-10-02', { description: 'reversal' })])).toEqual([])
    expect(matchRefunds([row('d', 'debit', 5000, '2026-10-01', { voided: true }), row('c', 'credit', 5000, '2026-10-02', { description: 'reversal' })])).toEqual([])
  })

  it('uses each debit once, taking the latest charge for a refund', () => {
    const rows = [
      row('d1', 'debit', 3000, '2026-10-01'), row('d2', 'debit', 3000, '2026-10-03'),
      row('c1', 'credit', 3000, '2026-10-04', { description: 'reversal' }), row('c2', 'credit', 3000, '2026-10-05', { description: 'reversal' }),
    ]
    const m = matchRefunds(rows)
    expect(m.map((x) => [x.credit.id, x.debit.id])).toEqual([['c1', 'd2'], ['c2', 'd1']])
  })
})

describe('excludeRefunded', () => {
  it('drops both legs and reports what came back', () => {
    const rows = [row('d', 'debit', 15000, '2026-10-01'), row('c', 'credit', 15000, '2026-10-04', { description: 'refund' }), row('x', 'debit', 700, '2026-10-02')]
    const out = excludeRefunded(rows)
    expect(out.rows.map((r) => r.id)).toEqual(['x'])
    expect(out.netted).toBe(15000)
  })

  it('returns the same rows untouched when nothing matches', () => {
    const rows = [row('x', 'debit', 700, '2026-10-02')]
    expect(excludeRefunded(rows).rows).toBe(rows)
  })
})
