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
 *
 * Every value here must also be a key in GATED_COLUMNS in schema.js, which is
 * what maps it to the file the user has to run -- and, more importantly, what
 * the startup probe actually asks the database about. A column listed here and
 * missing there is silently inert: the probe never checks it, `hasColumn`
 * always answers true, and the query goes out naming a column that may not
 * exist. That drift happened once with `voided` and would have reproduced the
 * outage; a test in tests/schema.test.js now fails if the two disagree.
 *
 * Exported for that test.
 */
export const GATED_LIST_COLUMNS = {
  explanation: 'transactions.explanation',
  voided: 'transactions.voided',
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

const BASE_SUMMARY_COLUMNS = [
  'id',
  'type',
  'amount',
  'category',
  'wallet_id',
  'transaction_date',
  'voided',
]

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
 * Hide voided transactions.
 *
 * Must be applied to every query that lists or totals transactions. A voided
 * row that leaks into one place and not another is worse than no void feature
 * at all: the ledger and the summary would disagree and there would be no way
 * to tell which was lying.
 *
 * `summarizeMonth` skips voided rows a second time, on the data rather than in
 * the query, so a call site that forgets this cannot corrupt the month totals.
 *
 * @param {object} query - a supabase query builder on `transactions`
 * @returns {object}
 */
export function excludeVoided(query) {
  // Before migration 006 there is nothing to exclude, and filtering on a column
  // that does not exist is a 42703 that takes the page down -- which is the
  // failure this whole capability check exists to prevent, and one this feature
  // would otherwise have caused a second time.
  if (!hasColumn('transactions.voided')) return query
  return query.eq('voided', false)
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

/** Longest search term we send. Beyond this it is a paste, not a search. */
const SEARCH_MAX = 60

/**
 * Quote a value so PostgREST reads it literally.
 *
 * PostgREST splits a filter list on commas and treats `.`, `:`, `(` and `)`
 * structurally. A search for "Rice, Chicken" would otherwise emit a second,
 * malformed condition -- 400 at best, and at worst a filter that quietly means
 * something other than what was typed. Double quotes make the value opaque;
 * inside them, `"` and `\` need escaping.
 */
function quoteFilterValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The OR-conditions a free-text search expands to, or null for no search.
 *
 * Searches the three fields that hold anything a human would recognise: the
 * bank's narration, who it went to, and the note. `category` is deliberately
 * absent -- there are chips for that, and including it would make searching
 * "food" return every meal rather than the one you meant.
 *
 * @param {string} raw
 * @returns {string[] | null}
 */
export function searchConditions(raw) {
  const trimmed = String(raw || '').trim()
  // One character matches most of the ledger; that is not a search result, it
  // is a full table scan rendered as a list.
  if (trimmed.length < 2) return null

  // % and _ are LIKE wildcards, and PostgREST gives no way to pass an ESCAPE
  // clause -- so a typed % would silently turn the search into "everything".
  const cleaned = trimmed.replace(/[%_]/g, '').slice(0, SEARCH_MAX)
  if (!cleaned) return null

  const pattern = quoteFilterValue(`%${cleaned}%`)
  const conditions = [
    `description.ilike.${pattern}`,
    `recipient.ilike.${pattern}`,
    `note.ilike.${pattern}`,
  ]

  // Typing an amount should find that amount. Exact rather than fuzzy: "5000"
  // meaning "roughly five thousand" is a different feature, and a wrong one to
  // guess at.
  const asNumber = Number(cleaned.replace(/[,₦\s]/g, ''))
  if (Number.isFinite(asNumber) && asNumber > 0) {
    conditions.push(`amount.eq.${asNumber}`)
  }

  return conditions
}

/**
 * Fold several OR-groups into the single `or=` PostgREST parameter.
 *
 * Two groups have to be AND'd together -- a wallet chip *and* a search term
 * means both must hold. The obvious way, calling `.or()` twice, emits two
 * `or=` keys; postgrest-js appends rather than replaces, and nothing in the
 * PostgREST documentation says how repeated top-level logical operators
 * combine. Guessing there means a filter that silently returns the wrong rows,
 * which is the exact failure this codebase keeps finding.
 *
 * Nested `and(...)` inside one `or=` *is* documented, so distribute instead:
 *
 *     (a OR b) AND (c OR d) == (a AND c) OR (a AND d) OR (b AND c) OR (b AND d)
 *
 * Cross-product size is bounded by the callers: at most two groups, of two and
 * four conditions, so at most eight terms.
 *
 * @param {Array<string[]>} groups
 * @returns {string | null}
 */
export function combineOrGroups(groups) {
  const present = (groups || []).filter((g) => g && g.length > 0)
  if (present.length === 0) return null
  if (present.length === 1) return present[0].join(',')

  let combos = present[0].map((c) => [c])
  for (let i = 1; i < present.length; i++) {
    combos = combos.flatMap((combo) => present[i].map((c) => [...combo, c]))
  }
  return combos.map((combo) => `and(${combo.join(',')})`).join(',')
}

/**
 * Apply a named filter and an optional search to a transactions query,
 * server-side.
 *
 * These have to run in Postgres rather than on the fetched array: with
 * pagination, filtering client-side would only ever search the page already
 * loaded, so "Uncategorized" would show whatever happened to be in the most
 * recent 50 rows rather than the actual answer.
 *
 * @param {object} query - a supabase query builder on `transactions`
 * @param {string} filter - filter id, e.g. 'All' or 'wallet:<uuid>'
 * @param {object[]} wallets
 * @param {string} search - free text; ignored when shorter than two characters
 * @returns {object} the query with the filter applied
 */
export function applyTransactionFilter(query, filter, wallets = [], search = '') {
  // Collected rather than applied inline, because a wallet chip and a search
  // both want an OR and only one `or=` may be sent. See combineOrGroups.
  const orGroups = []

  if (filter === 'Review') {
    query = query.eq(NEEDS_REVIEW_FILTER.column, NEEDS_REVIEW_FILTER.value)
  } else if (filter === 'This Week') {
    query = query.gte('transaction_date', daysAgo(7))
  } else if (filter === 'This Month') {
    query = query.gte('transaction_date', startOfMonth())
  } else if (filter === 'Needs') {
    query = query.eq('want_or_need', 'need')
  } else if (filter === 'Wants') {
    query = query.eq('want_or_need', 'want')
  } else if (filter === 'Uncategorized') {
    query = query.eq('category', 'Uncategorized')
  } else if (filter.startsWith('category:')) {
    // Exact match; category names are validated against ALL_CATEGORIES on
    // write, so no pattern escaping is needed.
    query = query.eq('category', filter.slice('category:'.length))
  } else if (filter.startsWith('wallet:')) {
    const walletId = filter.slice('wallet:'.length)
    const wallet = wallets.find((w) => w.id === walletId)
    if (wallet) {
      // Rows synced before wallets carried IDs only have `source`, so match
      // either. walletSource is imported rather than reimplemented: the two
      // must agree or the filter silently stops matching legacy rows.
      orGroups.push([`wallet_id.eq.${walletId}`, `source.eq.${walletSource(wallet)}`])
    }
  }

  const search_ = searchConditions(search)
  if (search_) orGroups.push(search_)

  const combined = combineOrGroups(orGroups)
  return combined ? query.or(combined) : query
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
