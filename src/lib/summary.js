import { ALL_CATEGORIES } from './constants'

/**
 * Month money math, shared by Budget and Daily HQ.
 *
 * Pure functions so the arithmetic is testable -- the previous inline versions
 * were wrong in two ways that a glance could not catch:
 *
 * 1. Transfers counted as spending. The savings exclusion was on the *wallet*,
 *    but a GTBank→PiggyVest transfer writes its debit leg on GTBank, a liquid
 *    wallet, so moving money to savings read as spending it.
 * 2. ATM cash was counted twice: once as the withdrawal debit, then again as
 *    the cash reconciliation logged the cash being spent down -- and the
 *    matching `Cash Received` credits inflated income.
 */

/**
 * Money changing pockets, not changing hands. Excluded from income and
 * spending totals and reported separately as `movedAside`.
 */
export const TRANSFER_CATEGORIES = ['Savings Transfer', 'Cash Withdrawal', 'Cash Received']

/**
 * Summarise a month of transactions.
 *
 * @param {Array<{type: string, amount: number|string, category?: string, wallet_id?: string}>} transactions
 *   rows already scoped to the month (TRANSACTION_SUMMARY_COLUMNS shape)
 * @param {Set<string>} liquidWalletIds - wallets counted toward income/spending;
 *   rows with no wallet_id are treated as liquid (legacy manual rows)
 * @returns {{income: number, spent: number, movedAside: number, byCategory: Array<{category: string, total: number}>}}
 */
export function summarizeMonth(transactions, liquidWalletIds) {
  let income = 0
  let spent = 0
  let movedAside = 0
  const byCategory = new Map()

  for (const t of transactions || []) {
    const amount = Number(t.amount) || 0
    if (amount <= 0) continue
    if (t.wallet_id && liquidWalletIds && !liquidWalletIds.has(t.wallet_id)) continue

    if (TRANSFER_CATEGORIES.includes(t.category)) {
      // Count each transfer once. A cash withdrawal is a debit leg
      // (Cash Withdrawal) and a credit leg (Cash Received); summing both sides
      // would double the amount "moved aside".
      if (t.type === 'debit') movedAside += amount
      continue
    }

    if (t.type === 'credit') {
      income += amount
    } else if (t.type === 'debit') {
      spent += amount
      const key = t.category || 'Uncategorized'
      byCategory.set(key, (byCategory.get(key) || 0) + amount)
    }
  }

  return {
    income,
    spent,
    movedAside,
    byCategory: [...byCategory.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total),
  }
}

/** Categories below this share of spending fold into "Other" in the breakdown. */
const OTHER_THRESHOLD = 0.03

/**
 * Shape category totals for a proportional-bar breakdown.
 *
 * @param {Array<{category: string, total: number}>} byCategory - from summarizeMonth
 * @returns {Array<{category: string, total: number, share: number}>}
 */
export function breakdownRows(byCategory) {
  const grandTotal = (byCategory || []).reduce((sum, c) => sum + c.total, 0)
  if (grandTotal <= 0) return []

  const rows = []
  let other = 0

  for (const c of byCategory) {
    if (c.total / grandTotal < OTHER_THRESHOLD) other += c.total
    else rows.push({ ...c, share: c.total / grandTotal })
  }

  if (other > 0) rows.push({ category: 'Other', total: other, share: other / grandTotal })
  return rows
}

/**
 * Daily burn and days of runway.
 *
 * Held back for the first two days of a month: one airtime purchase on the 1st
 * reads as a month-long burn rate and produces a terrifying nonsense number.
 * Capped at 90 because beyond that the figure stops being information.
 *
 * @param {number} liquidBalance
 * @param {number} spent - this month, transfers already excluded
 * @param {number} dayOfMonth - 1-31
 * @returns {{dailyBurn: number, daysOfRunway: number|null, capped: boolean} | null}
 */
export function runway(liquidBalance, spent, dayOfMonth) {
  if (dayOfMonth < 3) return null
  const dailyBurn = spent / dayOfMonth
  if (dailyBurn <= 0) return { dailyBurn: 0, daysOfRunway: null, capped: false }

  const days = Math.floor(Math.max(0, liquidBalance) / dailyBurn)
  return { dailyBurn, daysOfRunway: Math.min(days, 90), capped: days > 90 }
}

/** True for categories the app knows; used by tests to keep TRANSFER_CATEGORIES honest. */
export function isKnownCategory(category) {
  return ALL_CATEGORIES.includes(category)
}
