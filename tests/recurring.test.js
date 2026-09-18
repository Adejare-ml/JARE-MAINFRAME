import { describe, it, expect } from 'vitest'
import { detectRecurring } from '../src/lib/recurring.js'

const debit = (date, amount, overrides = {}) => ({
  type: 'debit',
  amount,
  transaction_date: date,
  recipient: 'Netflix',
  wallet_id: 'gt',
  category: 'Subscriptions',
  ...overrides,
})

describe('detectRecurring', () => {
  it('finds nothing with fewer than three occurrences', () => {
    const rows = [debit('2026-06-01', 3000), debit('2026-07-01', 3000)]
    expect(detectRecurring(rows, '2026-07-15')).toEqual([])
  })

  it('detects a monthly bill at a consistent amount and interval', () => {
    const rows = [debit('2026-05-01', 3000), debit('2026-06-01', 3000), debit('2026-07-01', 3000)]
    const [candidate] = detectRecurring(rows, '2026-07-15')

    expect(candidate.label).toBe('Netflix')
    expect(candidate.interval).toBe('monthly')
    expect(candidate.occurrences).toBe(3)
    expect(candidate.amount).toBe(3000)
    expect(candidate.lastDate).toBe('2026-07-01')
  })

  it('projects the next expected date from the median gap', () => {
    const rows = [debit('2026-05-01', 3000), debit('2026-06-01', 3000), debit('2026-07-01', 3000)]
    const [candidate] = detectRecurring(rows, '2026-07-15')
    // Gaps were May->June 31 days, June->July 30 days; median 30.5, rounded
    // up to 31. 2026-07-01 plus 31 days is 2026-08-01.
    expect(candidate.nextExpected).toBe('2026-08-01')
  })

  it('flags a projected date already in the past as overdue', () => {
    const rows = [debit('2026-05-01', 3000), debit('2026-06-01', 3000), debit('2026-07-01', 3000)]
    const [candidate] = detectRecurring(rows, '2026-08-15')
    expect(candidate.overdue).toBe(true)
  })

  it('detects a weekly pattern distinctly from monthly', () => {
    const rows = [
      debit('2026-07-06', 1500, { recipient: 'DSTV' }),
      debit('2026-07-13', 1500, { recipient: 'DSTV' }),
      debit('2026-07-20', 1500, { recipient: 'DSTV' }),
      debit('2026-07-27', 1500, { recipient: 'DSTV' }),
    ]
    const [candidate] = detectRecurring(rows, '2026-08-01')
    expect(candidate.interval).toBe('weekly')
  })

  it('tolerates small amount drift within 5%', () => {
    const rows = [debit('2026-05-01', 3000), debit('2026-06-01', 3080), debit('2026-07-01', 2950)]
    expect(detectRecurring(rows, '2026-07-15')).toHaveLength(1)
  })

  it('rejects amounts that drift too far to be the same bill', () => {
    const rows = [debit('2026-05-01', 3000), debit('2026-06-01', 6000), debit('2026-07-01', 3000)]
    expect(detectRecurring(rows, '2026-07-15')).toEqual([])
  })

  it('rejects an irregular interval even at a consistent amount', () => {
    const rows = [debit('2026-05-01', 3000), debit('2026-05-10', 3000), debit('2026-07-01', 3000)]
    expect(detectRecurring(rows, '2026-07-15')).toEqual([])
  })

  it('treats different wallets as different habits', () => {
    const rows = [
      debit('2026-05-01', 3000, { wallet_id: 'gt' }),
      debit('2026-06-01', 3000, { wallet_id: 'gt' }),
      debit('2026-07-01', 3000, { wallet_id: 'gt' }),
      debit('2026-05-05', 5000, { wallet_id: 'opay' }),
      debit('2026-06-05', 5000, { wallet_id: 'opay' }),
    ]
    // The gt group has 3 occurrences and qualifies; the opay group has only 2.
    expect(detectRecurring(rows, '2026-07-15')).toHaveLength(1)
  })

  it('ignores voided rows', () => {
    const rows = [
      debit('2026-05-01', 3000),
      debit('2026-06-01', 3000, { voided: true }),
      debit('2026-07-01', 3000),
    ]
    expect(detectRecurring(rows, '2026-07-15')).toEqual([])
  })

  it('ignores a same-day repeat rather than treating it as a zero-day interval', () => {
    const rows = [
      debit('2026-05-01', 3000),
      debit('2026-05-01', 3000),
      debit('2026-06-01', 3000),
      debit('2026-07-01', 3000),
    ]
    expect(detectRecurring(rows, '2026-07-15')).toEqual([])
  })

  it('reports higher confidence for a longer, tighter track record', () => {
    const short = [debit('2026-05-01', 3000), debit('2026-06-01', 3000), debit('2026-07-01', 3000)]
    const long = [
      debit('2026-01-01', 3000),
      debit('2026-02-01', 3000),
      debit('2026-03-01', 3000),
      debit('2026-04-01', 3000),
      debit('2026-05-01', 3000),
      debit('2026-06-01', 3000),
      debit('2026-07-01', 3000),
    ]
    const [shortCandidate] = detectRecurring(short, '2026-07-15')
    const [longCandidate] = detectRecurring(long, '2026-07-15')
    expect(longCandidate.confidence).toBeGreaterThanOrEqual(shortCandidate.confidence)
  })

  it('survives junk and empty input', () => {
    expect(detectRecurring([])).toEqual([])
    expect(detectRecurring(null)).toEqual([])
    expect(detectRecurring([null, {}, { transaction_date: null }, { amount: 'NaN' }])).toEqual([])
  })
})
