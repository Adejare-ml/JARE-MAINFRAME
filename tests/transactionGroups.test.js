import { describe, it, expect } from 'vitest'
import { groupByDate } from '../src/lib/transactionGroups.js'

const TODAY = '2026-09-18'
const YESTERDAY = '2026-09-17'

describe('groupByDate', () => {
  it('labels rows dated today as "Today"', () => {
    const groups = groupByDate([{ id: 1, transaction_date: TODAY }], TODAY)
    expect(groups).toEqual([{ date: TODAY, label: 'Today', rows: [{ id: 1, transaction_date: TODAY }] }])
  })

  it('labels rows dated yesterday as "Yesterday"', () => {
    const groups = groupByDate([{ id: 1, transaction_date: YESTERDAY }], TODAY)
    expect(groups[0].label).toBe('Yesterday')
  })

  it('labels anything older by its raw date, not a relative word', () => {
    const groups = groupByDate([{ id: 1, transaction_date: '2026-09-01' }], TODAY)
    expect(groups[0].label).toBe('2026-09-01')
  })

  it('keeps rows on the same date together, in their given order', () => {
    const groups = groupByDate(
      [
        { id: 1, transaction_date: TODAY },
        { id: 2, transaction_date: TODAY },
        { id: 3, transaction_date: YESTERDAY },
      ],
      TODAY,
    )
    expect(groups).toHaveLength(2)
    expect(groups[0].rows.map((r) => r.id)).toEqual([1, 2])
    expect(groups[1].rows.map((r) => r.id)).toEqual([3])
  })

  it('preserves the order dates are first seen in, not a re-sort', () => {
    // Regression against a "helpful" sort creeping in later: this function
    // groups, it does not decide display order -- that is the caller's job,
    // since a search result and a plain list may want different orders.
    const groups = groupByDate(
      [
        { id: 1, transaction_date: YESTERDAY },
        { id: 2, transaction_date: TODAY },
      ],
      TODAY,
    )
    expect(groups.map((g) => g.date)).toEqual([YESTERDAY, TODAY])
  })

  it('handles empty and malformed input', () => {
    expect(groupByDate([], TODAY)).toEqual([])
    expect(groupByDate(null, TODAY)).toEqual([])
  })
})
