/**
 * Where the week actually went.
 *
 * Dayflow's weekly review asks when you were focused, where the time went, and
 * what pulled you off track. The money answers are the same questions with a
 * different unit: which days you spent on, which categories took it, and
 * whether that is more or less than the week before.
 *
 * Every number here routes through `summarizeMonth` rather than re-adding the
 * amounts locally. Despite its name that function is period-agnostic -- it
 * takes rows the caller has already scoped -- and it is the single place that
 * knows a transfer to savings is not spending. A second definition of "what
 * counts" is how the month card and the week card end up disagreeing, which is
 * the class of bug this codebase keeps paying for.
 */

import { summarizeMonth } from './summary.js'
import { toDateOnly } from './queries.js'

/** Monday-first, matching startOfWeek. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Rows falling on `date`. */
function on(transactions, date) {
  return (transactions || []).filter((t) => t.transaction_date === date)
}

/**
 * Spend per day across a week, Monday first.
 *
 * @param {Array<object>} transactions - rows for the week
 * @param {Set<string>} liquidWalletIds
 * @param {string} weekStart - the Monday, YYYY-MM-DD
 * @param {string} [today] - days after this are marked `isFuture`
 * @returns {Array<{date: string, label: string, spent: number, isFuture: boolean, isToday: boolean}>}
 */
export function spendByWeekday(transactions, liquidWalletIds, weekStart, today = toDateOnly(new Date())) {
  const days = []
  const cursor = new Date(`${weekStart}T00:00:00`)

  for (let i = 0; i < 7; i++) {
    const date = toDateOnly(cursor)
    days.push({
      date,
      label: WEEKDAY_LABELS[i],
      spent: summarizeMonth(on(transactions, date), liquidWalletIds).spent,
      isFuture: date > today,
      isToday: date === today,
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  return days
}

/**
 * This week against last, for the figures that carry a verdict.
 *
 * `delta` is signed in money terms; `direction` says what that means, because
 * more income and more spending are not the same news. A caller reading only
 * the sign would colour a good week red half the time.
 *
 * `share` is null rather than 0 or Infinity when last week was zero: "up 100%"
 * from nothing is not a fact, it is a division that happened to complete.
 */
export function compareWeeks(thisWeek, lastWeek, liquidWalletIds) {
  const now = summarizeMonth(thisWeek, liquidWalletIds)
  const before = summarizeMonth(lastWeek, liquidWalletIds)

  const change = (a, b, lowerIsBetter) => {
    const delta = a - b
    return {
      now: a,
      before: b,
      delta,
      share: b > 0 ? delta / b : null,
      better: delta === 0 ? null : lowerIsBetter ? delta < 0 : delta > 0,
    }
  }

  return {
    spent: change(now.spent, before.spent, true),
    income: change(now.income, before.income, false),
    movedAside: change(now.movedAside, before.movedAside, false),
    byCategory: now.byCategory,
  }
}

/**
 * Unfinished weekly goals from the week that just ended.
 *
 * Named rather than dropped. A weekly target that quietly disappears on Monday
 * teaches you that the targets do not mean anything -- and the whole point of
 * writing one down is that missing it should be visible.
 *
 * @param {Array<object>} goals - weekly rows from the previous week
 * @param {(goal: object) => boolean} isDone
 */
export function carriedOver(goals, isDone) {
  return (goals || []).filter((g) => g && !isDone(g))
}
