/**
 * Debits worth a second look, found from the ledger alone.
 *
 * Two shapes, both cheap to state and hard to argue with. A debit far
 * above what this ledger usually sees (three times the median debit of the
 * last three months, and never under ₦10,000) is either the one purchase
 * of the month or a mistake, and both deserve a line in the morning
 * digest. Two debits of the same amount to the same payee from the same
 * wallet on the same day are the shape of a double charge, which Nigerian
 * POS terminals and web checkouts produce often enough to be worth naming.
 *
 * Pure: rows in, items out. Transfers between the owner's own accounts
 * are left out of both the baseline and the findings, as summarizeMonth
 * leaves them out of spending.
 */
import { TRANSFER_CATEGORIES } from './summary.js'

/** A debit under this is never "large", whatever the median. */
export const LARGE_FLOOR = 10_000
/** How many medians make a debit large. */
export const LARGE_MULTIPLIER = 3
/** How many recent days are examined; the rest is baseline only. */
export const RECENT_DAYS = 2
/** How far back the baseline looks. */
export const BASELINE_DAYS = 90
/** Fewer debits than this and the median means nothing: the floor alone decides. */
export const MIN_BASELINE = 10

const money = (n) => `₦${Math.round(Number(n) || 0).toLocaleString('en-US')}`

function dateOnly(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shift(today, days) {
  const d = new Date(`${today}T00:00:00`)
  d.setDate(d.getDate() + days)
  return dateOnly(d)
}

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function isSpendingDebit(t) {
  return t && t.type === 'debit' && !t.voided && Number(t.amount) > 0 && !TRANSFER_CATEGORIES.includes(t.category)
}

const payeeOf = (t) => String(t.recipient || t.description || '').trim().toLowerCase()

/**
 * @param {object[]} transactions - non-voided rows with type, amount, category, wallet_id, transaction_date, recipient
 * @param {{today?: string}} [options]
 * @returns {Array<{kind: 'large'|'double', text: string, amount: number, date: string}>}
 */
export function detectAnomalies(transactions = [], { today = dateOnly(new Date()) } = {}) {
  const recentFrom = shift(today, -(RECENT_DAYS - 1))
  const baselineFrom = shift(today, -BASELINE_DAYS)
  const debits = (transactions || []).filter(isSpendingDebit)

  const recent = debits.filter((t) => t.transaction_date >= recentFrom && t.transaction_date <= today)
  const baseline = debits.filter((t) => t.transaction_date >= baselineFrom && t.transaction_date < recentFrom)

  const typical = baseline.length >= MIN_BASELINE ? median(baseline.map((t) => Number(t.amount))) : null
  const threshold = Math.max(LARGE_FLOOR, typical ? typical * LARGE_MULTIPLIER : 0)

  const items = []
  for (const t of recent) {
    if (Number(t.amount) >= threshold) {
      const who = t.recipient || t.description || t.category || 'unnamed'
      items.push({
        kind: 'large',
        text: `${money(t.amount)} to ${who} on ${t.transaction_date} is well above your usual`,
        amount: Number(t.amount),
        date: t.transaction_date,
      })
    }
  }

  const groups = new Map()
  for (const t of recent) {
    const payee = payeeOf(t)
    if (!payee) continue
    const key = `${t.wallet_id || ''}|${t.transaction_date}|${Number(t.amount)}|${payee}`
    groups.set(key, (groups.get(key) || []).concat(t))
  }
  for (const rows of groups.values()) {
    if (rows.length < 2) continue
    const first = rows[0]
    items.push({
      kind: 'double',
      text: `${money(first.amount)} to ${first.recipient || first.description} charged ${rows.length} times on ${first.transaction_date}`,
      amount: Number(first.amount) * rows.length,
      date: first.transaction_date,
    })
  }

  return items.sort((a, b) => b.amount - a.amount)
}
