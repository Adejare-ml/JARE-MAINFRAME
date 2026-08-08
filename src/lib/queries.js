import { walletSource } from './sync/wallets.js'

/**
 * Shared Supabase query helpers for transactions.
 *
 * Two things every list query here gets right, which `select('*')` did not:
 *
 * 1. `raw_email` is never selected. It holds bank email bodies, and pulling it
 *    into a list view means every page load drags kilobytes per row over a
 *    mobile connection to render a number and a label.
 * 2. Rows are bounded and filtered in Postgres, not in the browser. Fetching
 *    the whole table and calling `.filter()` on it is invisible at 13 rows and
 *    painful at 5,000.
 */

/** Everything a list or summary view needs. Deliberately excludes raw_email. */
export const TRANSACTION_LIST_COLUMNS = [
  'id',
  'type',
  'amount',
  'currency',
  'source',
  'category',
  'description',
  'recipient',
  'note',
  'want_or_need',
  'wallet_id',
  'transaction_date',
  'transaction_time',
  'transaction_id',
  'available_balance',
  'confidence',
  'reviewed',
  'created_at',
].join(', ')

/** Just enough to add up. Used for monthly totals, where nothing is rendered. */
export const TRANSACTION_SUMMARY_COLUMNS = 'id, type, amount, wallet_id, transaction_date'

export const PAGE_SIZE = 50

/**
 * Format a Date as the YYYY-MM-DD that `transaction_date` stores.
 * Uses local time: "this month" should mean the user's month, not UTC's.
 *
 * @param {Date} date
 * @returns {string}
 */
export function toDateOnly(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** First day of the month containing `date`, as YYYY-MM-DD. */
export function startOfMonth(date = new Date()) {
  return toDateOnly(new Date(date.getFullYear(), date.getMonth(), 1))
}

/** `days` days before `date`, as YYYY-MM-DD. */
export function daysAgo(days, date = new Date()) {
  const d = new Date(date)
  d.setDate(d.getDate() - days)
  return toDateOnly(d)
}

/**
 * Apply a named filter to a transactions query, server-side.
 *
 * These have to run in Postgres rather than on the fetched array: with
 * pagination, filtering client-side would only ever search the page already
 * loaded, so "Uncategorized" would show whatever happened to be in the most
 * recent 50 rows rather than the actual answer.
 *
 * @param {object} query - a supabase query builder on `transactions`
 * @param {string} filter - filter id, e.g. 'All' or 'wallet:<uuid>'
 * @param {object[]} wallets
 * @returns {object} the query with the filter applied
 */
export function applyTransactionFilter(query, filter, wallets = []) {
  if (filter === 'Review') {
    return query.or('reviewed.eq.false,category.eq.Uncategorized')
  }
  if (filter === 'This Week') {
    return query.gte('transaction_date', daysAgo(7))
  }
  if (filter === 'This Month') {
    return query.gte('transaction_date', startOfMonth())
  }
  if (filter === 'Needs') {
    return query.eq('want_or_need', 'need')
  }
  if (filter === 'Wants') {
    return query.eq('want_or_need', 'want')
  }
  if (filter === 'Uncategorized') {
    return query.eq('category', 'Uncategorized')
  }

  if (filter.startsWith('wallet:')) {
    const walletId = filter.slice('wallet:'.length)
    const wallet = wallets.find((w) => w.id === walletId)
    if (!wallet) return query

    // Rows synced before wallets carried IDs only have `source`, so match
    // either. walletSource is imported rather than reimplemented: the two must
    // agree or the filter silently stops matching legacy rows, and it is
    // sanitised to [a-z0-9_] because PostgREST splits this string on commas --
    // a wallet named "GTBank, Naira" would otherwise emit a third, malformed
    // condition and 400 the whole query.
    const sourceSlug = walletSource(wallet)
    return query.or(`wallet_id.eq.${walletId},source.eq.${sourceSlug}`)
  }

  return query
}

/**
 * Build the filter chips. Wallet entries come from the wallets table rather
 * than a hardcoded list, so a bank added in Settings is immediately filterable
 * and a removed one stops appearing.
 *
 * @param {object[]} wallets
 * @returns {Array<{id: string, label: string}>}
 */
export function buildFilterOptions(wallets = []) {
  const walletChips = wallets
    .filter((w) => w.is_active !== false)
    .map((w) => ({ id: `wallet:${w.id}`, label: w.name }))

  return [
    { id: 'All', label: 'All' },
    { id: 'Review', label: 'Review' },
    { id: 'This Week', label: 'This Week' },
    { id: 'This Month', label: 'This Month' },
    ...walletChips,
    { id: 'Needs', label: 'Needs' },
    { id: 'Wants', label: 'Wants' },
    { id: 'Uncategorized', label: 'Uncategorized' },
  ]
}
