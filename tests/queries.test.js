import { describe, it, expect, vi } from 'vitest'
import {
  TRANSACTION_LIST_COLUMNS,
  TRANSACTION_SUMMARY_COLUMNS,
  toDateOnly,
  startOfMonth,
  daysAgo,
  applyTransactionFilter,
  buildFilterOptions,
  needsReview,
} from '../src/lib/queries.js'

/** Minimal stand-in for a Supabase query builder that records what was called. */
function fakeQuery() {
  const calls = []
  const builder = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'calls') return calls
        return (...args) => {
          calls.push({ method: prop, args })
          return builder
        }
      },
    },
  )
  return builder
}

describe('column lists', () => {
  // raw_email holds full bank email bodies. Selecting it into a list view means
  // dragging kilobytes per row over mobile data to render a number and a label.
  it('never include raw_email', () => {
    expect(TRANSACTION_LIST_COLUMNS).not.toContain('raw_email')
    expect(TRANSACTION_SUMMARY_COLUMNS).not.toContain('raw_email')
  })

  it('include the fields the list view renders', () => {
    for (const col of ['id', 'type', 'amount', 'category', 'description', 'transaction_date', 'reviewed']) {
      expect(TRANSACTION_LIST_COLUMNS).toContain(col)
    }
  })

  it('keep the summary list to what totals need', () => {
    expect(TRANSACTION_SUMMARY_COLUMNS).toContain('amount')
    expect(TRANSACTION_SUMMARY_COLUMNS).toContain('type')
    expect(TRANSACTION_SUMMARY_COLUMNS).not.toContain('description')
  })
})

describe('date helpers', () => {
  it('formats as the YYYY-MM-DD that transaction_date stores', () => {
    expect(toDateOnly(new Date(2026, 7, 7))).toBe('2026-08-07')
    expect(toDateOnly(new Date(2026, 0, 1))).toBe('2026-01-01')
  })

  // "This month" should mean the user's month in Lagos, not UTC's -- near
  // midnight those are different days.
  it('uses local time, not UTC', () => {
    const lateEvening = new Date(2026, 7, 7, 23, 30)
    expect(toDateOnly(lateEvening)).toBe('2026-08-07')
  })

  it('finds the first of the month', () => {
    expect(startOfMonth(new Date(2026, 7, 22))).toBe('2026-08-01')
    expect(startOfMonth(new Date(2026, 0, 31))).toBe('2026-01-01')
  })

  it('counts back across a month boundary', () => {
    expect(daysAgo(7, new Date(2026, 7, 3))).toBe('2026-07-27')
    expect(daysAgo(1, new Date(2026, 0, 1))).toBe('2025-12-31')
  })
})

describe('applyTransactionFilter', () => {
  const wallets = [
    { id: 'w1', name: 'GTBank', is_active: true },
    { id: 'w2', name: 'Zenith Bank', is_active: true },
  ]

  it('leaves an unfiltered query alone', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'All', wallets)
    expect(q.calls).toHaveLength(0)
  })

  // Now that the sync marks a row reviewed only when direction AND category are
  // both settled, `reviewed` is the whole signal. The old version also matched
  // category = Uncategorized, which would drag a row you deliberately reviewed
  // and left uncategorized back into the queue forever.
  it('matches the review queue on the reviewed flag alone', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'Review', wallets)
    expect(q.calls[0]).toEqual({ method: 'eq', args: ['reviewed', false] })
  })

  it('keeps the client-side predicate in step with the query', () => {
    expect(needsReview({ reviewed: false, category: 'Transport' })).toBe(true)
    expect(needsReview({ reviewed: true, category: 'Uncategorized' })).toBe(false)
    expect(needsReview({ reviewed: true, category: 'Transport' })).toBe(false)
  })

  // Filtering must happen in Postgres: with pagination, filtering the fetched
  // array would only ever search the 50 rows already loaded.
  it('pushes date filters to the database', () => {
    const week = fakeQuery()
    applyTransactionFilter(week, 'This Week', wallets)
    expect(week.calls[0].method).toBe('gte')
    expect(week.calls[0].args[0]).toBe('transaction_date')

    const month = fakeQuery()
    applyTransactionFilter(month, 'This Month', wallets)
    expect(month.calls[0].args[1]).toBe(startOfMonth())
  })

  it('filters needs, wants and uncategorized by column', () => {
    const needs = fakeQuery()
    applyTransactionFilter(needs, 'Needs', wallets)
    expect(needs.calls[0]).toEqual({ method: 'eq', args: ['want_or_need', 'need'] })

    const uncat = fakeQuery()
    applyTransactionFilter(uncat, 'Uncategorized', wallets)
    expect(uncat.calls[0]).toEqual({ method: 'eq', args: ['category', 'Uncategorized'] })
  })

  it('matches a wallet by id or by legacy source slug', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'wallet:w2', wallets)
    // Rows synced before wallets carried IDs only have `source`.
    expect(q.calls[0]).toEqual({ method: 'or', args: ['wallet_id.eq.w2,source.eq.zenith_bank'] })
  })

  it('prefers the wallet’s immutable slug over its name', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'wallet:w3', [{ id: 'w3', name: 'Renamed Later', source_slug: 'gtbank' }])
    expect(q.calls[0].args[0]).toBe('wallet_id.eq.w3,source.eq.gtbank')
  })

  // PostgREST splits the .or() string on commas, so a name containing one used
  // to emit a third malformed condition and 400 the whole query, which the page
  // rendered as "Failed to load transactions".
  it('cannot be broken by punctuation in a wallet name', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'wallet:w4', [{ id: 'w4', name: 'GTBank, Naira' }])

    const filter = q.calls[0].args[0]
    expect(filter).toBe('wallet_id.eq.w4,source.eq.gtbank_naira')
    // Exactly two conditions, not three.
    expect(filter.split(',')).toHaveLength(2)
  })

  it('ignores a wallet filter for a wallet that no longer exists', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'wallet:deleted', wallets)
    expect(q.calls).toHaveLength(0)
  })
})

describe('buildFilterOptions', () => {
  const wallets = [
    { id: 'w1', name: 'GTBank', is_active: true },
    { id: 'w2', name: 'PiggyVest', is_active: true },
    { id: 'w3', name: 'Old Bank', is_active: false },
  ]

  // The old hardcoded GTBank/OPay/Cash list went stale the moment Zenith,
  // Polaris and PiggyVest were added in Settings.
  it('builds wallet chips from the wallets table', () => {
    const options = buildFilterOptions(wallets)
    expect(options).toContainEqual({ id: 'wallet:w1', label: 'GTBank' })
    expect(options).toContainEqual({ id: 'wallet:w2', label: 'PiggyVest' })
  })

  it('omits inactive wallets', () => {
    expect(buildFilterOptions(wallets).map(o => o.label)).not.toContain('Old Bank')
  })

  it('always offers the standing filters', () => {
    const ids = buildFilterOptions([]).map(o => o.id)
    expect(ids).toEqual(['All', 'Review', 'This Week', 'This Month', 'Needs', 'Wants', 'Uncategorized'])
  })

  it('handles a missing wallet list', () => {
    expect(buildFilterOptions().length).toBeGreaterThan(0)
  })
})
