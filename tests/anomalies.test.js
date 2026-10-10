import { describe, it, expect } from 'vitest'
import { detectAnomalies, median, LARGE_FLOOR, MIN_BASELINE } from '../src/lib/anomalies.js'

const TODAY = '2026-10-10'
const debit = (amount, date, extra = {}) => ({
  type: 'debit', amount, transaction_date: date, wallet_id: 'w1', category: 'Transport', recipient: 'BOLT', ...extra,
})
// Thirty ordinary debits of ₦1,500 spread over September: a median of 1,500.
const baseline = Array.from({ length: 30 }, (_, i) => debit(1500, `2026-09-${String((i % 28) + 1).padStart(2, '0')}`))

describe('median', () => {
  it('handles odd, even and empty lists', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('large debits', () => {
  it('flags a recent debit three medians above the usual, never under the floor', () => {
    const rows = [...baseline, debit(4600, TODAY, { recipient: 'PAYSTACK' }), debit(9000, TODAY)]
    // 3 × 1,500 = 4,500 but the floor is 10,000: neither counts.
    expect(detectAnomalies(rows, { today: TODAY })).toEqual([])
    const big = detectAnomalies([...rows, debit(12000, TODAY, { recipient: 'JUMIA' })], { today: TODAY })
    expect(big).toHaveLength(1)
    expect(big[0].kind).toBe('large')
    expect(big[0].text).toContain('₦12,000 to JUMIA')
  })

  it('uses the median once there is enough history', () => {
    const rich = Array.from({ length: MIN_BASELINE }, (_, i) => debit(20000, `2026-09-${String(i + 1).padStart(2, '0')}`))
    // Median 20,000 → threshold 60,000; a 30,000 debit is ordinary here.
    expect(detectAnomalies([...rich, debit(30000, TODAY)], { today: TODAY })).toEqual([])
    expect(detectAnomalies([...rich, debit(61000, TODAY)], { today: TODAY })).toHaveLength(1)
  })

  it('ignores credits, voided rows, own-account transfers and older days', () => {
    const rows = [
      ...baseline,
      { ...debit(50000, TODAY), type: 'credit' },
      { ...debit(50000, TODAY), voided: true },
      debit(50000, TODAY, { category: 'Savings Transfer' }),
      debit(50000, '2026-10-01'),
    ]
    expect(detectAnomalies(rows, { today: TODAY })).toEqual([])
    expect(LARGE_FLOOR).toBe(10000)
  })
})

describe('double charges', () => {
  it('names two identical debits to one payee on one day from one wallet', () => {
    const rows = [debit(3500, TODAY, { recipient: 'SHOPRITE' }), debit(3500, TODAY, { recipient: 'shoprite ' })]
    const found = detectAnomalies(rows, { today: TODAY })
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('double')
    expect(found[0].text).toBe('₦3,500 to SHOPRITE charged 2 times on 2026-10-10')
  })

  it('leaves different wallets, days, amounts or unnamed payees alone', () => {
    const rows = [
      debit(3500, TODAY, { recipient: 'SHOPRITE' }), debit(3500, TODAY, { recipient: 'SHOPRITE', wallet_id: 'w2' }),
      debit(2000, TODAY, { recipient: 'A' }), debit(2000, '2026-10-09', { recipient: 'A' }),
      debit(500, TODAY, { recipient: '', description: '' }), debit(500, TODAY, { recipient: '', description: '' }),
    ]
    expect(detectAnomalies(rows, { today: TODAY })).toEqual([])
  })

  it('sorts the largest finding first', () => {
    const rows = [...baseline, debit(15000, TODAY, { recipient: 'X' }), debit(9000, TODAY, { recipient: 'Y' }), debit(9000, TODAY, { recipient: 'Y' })]
    expect(detectAnomalies(rows, { today: TODAY }).map((a) => a.kind)).toEqual(['double', 'large'])
  })
})
