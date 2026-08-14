import { describe, it, expect, vi } from 'vitest'
import {
  transactionListColumns,
  transactionSummaryColumns,
  orderGoalsBySlot,
  toDateOnly,
  startOfMonth,
  endOfMonth,
  daysAgo,
  startOfWeek,
  endOfWeek,
  weeksAgo,
  applyTransactionFilter,
  buildFilterOptions,
  needsReview,
  excludeVoided,
  searchConditions,
  combineOrGroups,
} from '../src/lib/queries.js'
import { setSchemaCapabilities, resetSchemaCapabilities } from '../src/lib/schema.js'

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
    expect(transactionListColumns()).not.toContain('raw_email')
    expect(transactionSummaryColumns()).not.toContain('raw_email')
  })

  it('include the fields the list view renders', () => {
    for (const col of ['id', 'type', 'amount', 'category', 'description', 'transaction_date', 'reviewed']) {
      expect(transactionListColumns()).toContain(col)
    }
  })

  it('keep the summary list to what totals need', () => {
    expect(transactionSummaryColumns()).toContain('amount')
    expect(transactionSummaryColumns()).toContain('type')
    expect(transactionSummaryColumns()).not.toContain('description')
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

  it('finds the last day of the month, including February', () => {
    expect(endOfMonth(new Date(2026, 7, 10))).toBe('2026-08-31')
    expect(endOfMonth(new Date(2026, 3, 10))).toBe('2026-04-30')
    // 2028 is a leap year; 2026 is not. A hardcoded month-length table gets
    // exactly this wrong once every four years.
    expect(endOfMonth(new Date(2026, 1, 10))).toBe('2026-02-28')
    expect(endOfMonth(new Date(2028, 1, 10))).toBe('2028-02-29')
  })
})

describe('calendar weeks', () => {
  // 2026-08-10 is a Monday, so that week runs 10th to 16th August.
  it('starts the week on Monday', () => {
    expect(startOfWeek(new Date(2026, 7, 10))).toBe('2026-08-10')
    expect(startOfWeek(new Date(2026, 7, 13))).toBe('2026-08-10')
    expect(endOfWeek(new Date(2026, 7, 13))).toBe('2026-08-16')
  })

  // The off-by-one that makes hand-rolled versions wrong one day in seven:
  // getDay() returns 0 for Sunday, so a naive `date - getDay()` throws Sunday
  // forward into the week that has not started yet.
  it('puts Sunday at the END of its week, not the start of the next', () => {
    const sunday = new Date(2026, 7, 16)
    expect(sunday.getDay()).toBe(0)
    expect(startOfWeek(sunday)).toBe('2026-08-10')
    expect(endOfWeek(sunday)).toBe('2026-08-16')
  })

  it('handles a week spanning a month boundary', () => {
    // Mon 31 Aug 2026 through Sun 6 Sep 2026.
    expect(startOfWeek(new Date(2026, 8, 2))).toBe('2026-08-31')
    expect(endOfWeek(new Date(2026, 8, 2))).toBe('2026-09-06')
  })

  it('handles a week spanning a year boundary', () => {
    // Mon 28 Dec 2026 through Sun 3 Jan 2027.
    expect(startOfWeek(new Date(2026, 11, 30))).toBe('2026-12-28')
    expect(endOfWeek(new Date(2026, 11, 30))).toBe('2027-01-03')
  })

  // Same bug class as toDateOnly's: the UTC form of a Lagos date is the
  // previous day between midnight and 1am, which once made Daily HQ load
  // yesterday's priorities.
  it('uses local time at both ends of the day', () => {
    expect(startOfWeek(new Date(2026, 7, 13, 0, 30))).toBe('2026-08-10')
    expect(startOfWeek(new Date(2026, 7, 13, 23, 30))).toBe('2026-08-10')
  })

  it('steps back whole weeks from the Monday', () => {
    expect(weeksAgo(1, new Date(2026, 7, 13))).toBe('2026-08-03')
    expect(weeksAgo(4, new Date(2026, 7, 13))).toBe('2026-07-13')
    expect(weeksAgo(0, new Date(2026, 7, 13))).toBe('2026-08-10')
  })

  it('always spans exactly seven days', () => {
    // Every day of one week must agree on where that week begins and ends.
    for (let day = 10; day <= 16; day++) {
      const d = new Date(2026, 7, day)
      expect(startOfWeek(d)).toBe('2026-08-10')
      expect(endOfWeek(d)).toBe('2026-08-16')
    }
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

describe('excludeVoided', () => {
  it('filters on voided = false', () => {
    const q = fakeQuery()
    excludeVoided(q)
    expect(q.calls).toContainEqual({ method: 'eq', args: ['voided', false] })
  })

  it('returns the builder so it composes with a filter', () => {
    const q = fakeQuery()
    applyTransactionFilter(excludeVoided(q), 'Uncategorized')
    expect(q.calls).toEqual([
      { method: 'eq', args: ['voided', false] },
      { method: 'eq', args: ['category', 'Uncategorized'] },
    ])
  })
})

describe('searchConditions', () => {
  it('ignores a search shorter than two characters', () => {
    for (const q of ['', ' ', 'a', null, undefined]) {
      expect(searchConditions(q)).toBeNull()
    }
  })

  it('searches the three human-readable fields', () => {
    const conditions = searchConditions('chicken')
    expect(conditions).toEqual([
      'description.ilike."%chicken%"',
      'recipient.ilike."%chicken%"',
      'note.ilike."%chicken%"',
    ])
  })

  it('quotes the value so a comma cannot forge a second condition', () => {
    // Unquoted, PostgREST splits this list on the comma and reads "Chicken%"
    // as a whole condition of its own -- a 400 at best, and at worst a filter
    // that means something other than what was typed.
    const conditions = searchConditions('Rice, Chicken')
    expect(conditions[0]).toBe('description.ilike."%Rice, Chicken%"')
  })

  it('escapes quotes and backslashes inside the value', () => {
    expect(searchConditions('say "hi"')[0]).toBe('description.ilike."%say \\"hi\\"%"')
    expect(searchConditions('back\\slash')[0]).toBe('description.ilike."%back\\\\slash%"')
  })

  it('strips LIKE wildcards so a typed % is not a match-everything', () => {
    // There is no way to pass an ESCAPE clause through PostgREST, so a literal
    // % would silently widen the search to the whole table.
    expect(searchConditions('%%%%')).toBeNull()
    expect(searchConditions('ric%e')[0]).toBe('description.ilike."%rice%"')
  })

  it('adds an exact amount match when the search is a number', () => {
    expect(searchConditions('5000')).toContain('amount.eq.5000')
    expect(searchConditions('₦5,000')).toContain('amount.eq.5000')
  })

  it('does not add an amount match for text', () => {
    expect(searchConditions('chicken').some(c => c.startsWith('amount'))).toBe(false)
  })
})

describe('combineOrGroups', () => {
  it('returns null when there is nothing to combine', () => {
    expect(combineOrGroups([])).toBeNull()
    expect(combineOrGroups([[], null])).toBeNull()
  })

  it('passes a single group through unwrapped', () => {
    expect(combineOrGroups([['a.eq.1', 'b.eq.2']])).toBe('a.eq.1,b.eq.2')
  })

  it('distributes two groups into one or= rather than emitting two', () => {
    // (a OR b) AND (c OR d). Calling .or() twice appends two or= keys and
    // nothing documents how PostgREST combines them; nested and(...) inside a
    // single or= is documented, so the cross product is the safe form.
    expect(combineOrGroups([['a.eq.1', 'b.eq.2'], ['c.eq.3', 'd.eq.4']])).toBe(
      'and(a.eq.1,c.eq.3),and(a.eq.1,d.eq.4),and(b.eq.2,c.eq.3),and(b.eq.2,d.eq.4)',
    )
  })
})

describe('filter and search composition', () => {
  const wallets = [{ id: 'w1', name: 'GTBank', source_slug: 'gtbank', is_active: true }]

  it('sends exactly one or= when a wallet chip and a search are both active', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'wallet:w1', wallets, 'chicken')
    const ors = q.calls.filter(c => c.method === 'or')
    expect(ors).toHaveLength(1)
    // Every term must carry both a wallet condition and a search condition.
    for (const term of ors[0].args[0].split('),and(')) {
      expect(term).toMatch(/wallet_id\.eq\.w1|source\.eq\.gtbank/)
      expect(term).toMatch(/ilike|amount\.eq/)
    }
  })

  it('keeps a non-or filter as its own eq alongside the search or=', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'Review', [], 'chicken')
    expect(q.calls).toContainEqual({ method: 'eq', args: ['reviewed', false] })
    expect(q.calls.filter(c => c.method === 'or')).toHaveLength(1)
  })

  it('sends no or= at all when neither a wallet nor a search is active', () => {
    const q = fakeQuery()
    applyTransactionFilter(q, 'This Month', [], '')
    expect(q.calls.filter(c => c.method === 'or')).toHaveLength(0)
  })
})
