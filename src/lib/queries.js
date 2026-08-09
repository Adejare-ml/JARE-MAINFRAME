import { walletSource } from './sync/wallets.js'
import { hasColumn } from './schema.js'

/**
 * Shared Supabase query helpers for transactions.
 *
 * Three things every list query here gets right, which `select('*')` did not:
 *
 * 1. `raw_email` is never selected. It holds bank email bodies, and pulling it
 *    into a list view means every page load drags kilobytes per row over a
 *    mobile connection to render a number and a label.
 * 2. Rows are bounded and filtered in Postgres, not in the browser. Fetching
 *    the whole table and calling `.filter()` on it is invisible at 13 rows and
 *    painful at 5,000.
 * 3. Columns that arrive with a migration are dropped from the list when the
 *    database has not caught up. This is not hypothetical tidiness: naming one
 *    such column unconditionally is what took Daily HQ, Budget and the Ledger
 *    down together. See src/lib/schema.js.
 */

/**
 * Columns a list view wants but only gets after a migration has been run.
 * Every entry must also appear in GATED_COLUMNS in schema.js, which is what
 * maps it to the file the user has to run.
 */
const GATED_LIST_COLUMNS = {
  explanation: 'transactions.explanation',
}

const BASE_LIST_COLUMNS = [
  'id',
  'type',
  'amount',
  'currency',
  'source',
  'category',
  'description',
  'recipient',
  'note',
  'explanation',
  'want_or_need',
  'wallet_id',
  'transaction_date',
  'transaction_time',
  'transaction_id',
  'available_balance',
  'confidence',
  'reviewed',
  'created_at',
]

const BASE_SUMMARY_COLUMNS = ['id', 'type', 'amount', 'category', 'wallet_id', 'transaction_date']

/** Drop any column the database does not have yet. */
function available(columns) {
  return columns.filter((c) => !GATED_LIST_COLUMNS[c] || hasColumn(GATED_LIST_COLUMNS[c])).join(', ')
}

/**
 * Order a goals query by slot, but only if `slot` exists.
 *
 * Same trap as the transaction column list, in a different shape: ordering by a
 * column the database does not have is a 42703 that takes the whole page down.
 * Without 003 the goals still load, just in creation order -- which is what the
 * app did before slots existed.
 *
 * @param {object} query - a supabase query builder on `goals`
 */
export function orderGoalsBySlot(query) {
  const ordered = hasColumn('goals.slot')
    ? query.order('slot', { ascending: true, nullsFirst: false })
    : query
  return ordered.order('created_at', { ascending: true })
}

/**
 * Everything a list or summary view needs. Deliberately excludes raw_email.
 *
 * A function rather than a constant because the answer depends on the live
 * schema, which is not known until the probe runs. Call it at query time, not
 * at module scope.
 */
export function transactionListColumns() {
  return available(BASE_LIST_COLUMNS)
}

/** Just enough to add up. `category` is here because the month totals must
 *  exclude transfer categories (Savings Transfer, Cash Withdrawal, Cash
 *  Received) -- without it, moving money to PiggyVest reads as spending it. */
export function transactionSummaryColumns() {
  return available(BASE_SUMMARY_COLUMNS)
}

export const PAGE_SIZE = 50

/**
 * What "needs my attention" means, in one place.
 *
 * This predicate used to be written out at four separate call sites, which is
 * three chances for them to disagree. It also used to include
 * `category.eq.Uncategorized`; that clause is now redundant and actively
 * harmful — the sync marks a row reviewed only when both its direction and its
 * category are settled, so an Uncategorized row is always unreviewed anyway,
 * while a row you deliberately reviewed and left as Uncategorized would be
 * dragged back into the queue forever.
 */
export const NEEDS_REVIEW_FILTER = { column: 'reviewed', value: false }

/** True for a row the review queue should show. Mirrors the query predicate. */
export function needsReview(txn) {
  return txn?.reviewed === false
}

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
    return query.eq(NEEDS_REVIEW_FILTER.column, NEEDS_REVIEW_FILTER.value)
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

  if (filter.startsWith('category:')) {
    // Exact match; category names are validated against ALL_CATEGORIES on
    // write, so no pattern escaping is needed.
    return query.eq('category', filter.slice('category:'.length))
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
