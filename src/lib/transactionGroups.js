import { toDateOnly, daysAgo } from './queries.js'

/**
 * Group already-sorted transactions into date sections for a sticky-header
 * list. Pure so the "Today"/"Yesterday" labeling can be tested without
 * mounting the page -- the boundary case (a row dated today rendering under
 * "Today" rather than its raw date) is exactly the kind of one-line mistake
 * that is cheap to get wrong and cheap to test.
 *
 * @param {Array<{transaction_date: string}>} transactions - already sorted,
 *   any order; rows keep whatever relative order they arrive in within a group
 * @param {string} [today] - toDateOnly(new Date()) by default; a parameter so
 *   tests do not depend on the day they happen to run
 * @returns {Array<{date: string, label: string, rows: Array}>}
 */
export function groupByDate(transactions, today = toDateOnly(new Date())) {
  const yesterday = daysAgo(1, today)
  const groups = new Map()

  for (const t of transactions || []) {
    const date = t.transaction_date
    if (!groups.has(date)) groups.set(date, [])
    groups.get(date).push(t)
  }

  return [...groups.entries()].map(([date, rows]) => ({
    date,
    label: date === today ? 'Today' : date === yesterday ? 'Yesterday' : date,
    rows,
  }))
}
