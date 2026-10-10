/**
 * The month in a few sentences, computed rather than written.
 *
 * The weekly recap asks a model to phrase facts and then checks every
 * number it used. A month has fewer, bigger facts -- total spent against
 * last month, income, the category that moved most, the envelopes that
 * burst, what went to savings, what came back as refunds -- and each one
 * has exactly one honest sentence, so there is nothing for a model to add
 * and nothing for a review step to catch. Every figure routes through
 * summarizeMonth, the one definition of "what counts".
 *
 * Pure. Returns [] for a month with no rows, which the card reads as
 * "no card", not as an error.
 */
import { summarizeMonth } from './summary.js'

const money = (n) => `₦${Math.round(Number(n) || 0).toLocaleString('en-US')}`

/** "up 12%", "down 3%", "about the same". Null when there is nothing to compare. */
export function describeChange(now, before) {
  if (!(before > 0)) return null
  const pct = Math.round(((now - before) / before) * 100)
  if (Math.abs(pct) < 3) return 'about the same as last month'
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on last month`
}

/** How many categories and envelopes to name before the sentence gets long. */
export const MAX_NAMED = 3

/**
 * @param {object} input
 * @param {object[]} input.thisMonth - the month's non-voided rows (refunds already netted if wanted)
 * @param {object[]} [input.lastMonth] - the prior month's rows, for comparison
 * @param {Set<string>} [input.liquidWalletIds]
 * @param {Record<string, number>} [input.budgetByCategory] - category -> monthly target
 * @param {number} [input.refundsNetted] - money that came back and was left out of both sides
 * @param {string} [input.label] - "September 2026", for the first sentence
 * @returns {Array<{key: string, text: string}>}
 */
export function buildMonthRecap({
  thisMonth = [],
  lastMonth = [],
  liquidWalletIds = null,
  budgetByCategory = {},
  refundsNetted = 0,
  label = 'This month',
} = {}) {
  const now = summarizeMonth(thisMonth, liquidWalletIds)
  const before = summarizeMonth(lastMonth, liquidWalletIds)
  if (now.spent <= 0 && now.income <= 0 && now.movedAside <= 0) return []

  const out = []
  const spentChange = describeChange(now.spent, before.spent)
  out.push({
    key: 'spent',
    text: `${label}: ${money(now.spent)} spent${spentChange ? `, ${spentChange}` : ''}.`,
  })

  if (now.income > 0) {
    const incomeChange = describeChange(now.income, before.income)
    const kept = now.income - now.spent
    out.push({
      key: 'income',
      text: `${money(now.income)} came in${incomeChange ? ` (${incomeChange})` : ''}; ${kept >= 0 ? `${money(kept)} of it stayed` : `${money(-kept)} more went out than came in`}.`,
    })
  }

  const top = now.byCategory[0]
  if (top) {
    const prior = before.byCategory.find((c) => c.category === top.category)?.total || 0
    const change = describeChange(top.total, prior)
    out.push({
      key: 'top',
      text: `Biggest line: ${top.category} at ${money(top.total)}${change ? `, ${change}` : ''}.`,
    })
  }

  // The category whose amount moved most against last month, when it is
  // not already the biggest line.
  let mover = null
  const priorBy = new Map(before.byCategory.map((c) => [c.category, c.total]))
  for (const { category, total } of now.byCategory) {
    const delta = total - (priorBy.get(category) || 0)
    if (category !== top?.category && Math.abs(delta) >= 5000 && (!mover || Math.abs(delta) > Math.abs(mover.delta))) {
      mover = { category, delta }
    }
  }
  if (mover) {
    out.push({
      key: 'mover',
      text: `${mover.category} ${mover.delta > 0 ? 'rose' : 'fell'} by ${money(Math.abs(mover.delta))}.`,
    })
  }

  const over = now.byCategory
    .filter((c) => budgetByCategory[c.category] > 0 && c.total > budgetByCategory[c.category])
    .map((c) => `${c.category} (${money(c.total - budgetByCategory[c.category])} over)`)
  if (over.length > 0) {
    const named = over.slice(0, MAX_NAMED).join(', ')
    const rest = over.length > MAX_NAMED ? ` and ${over.length - MAX_NAMED} more` : ''
    out.push({ key: 'over', text: `Over budget: ${named}${rest}.` })
  }

  if (now.movedAside > 0) {
    out.push({ key: 'saved', text: `${money(now.movedAside)} moved to savings or between your accounts.` })
  }

  if (refundsNetted > 0) {
    out.push({ key: 'refunds', text: `${money(refundsNetted)} came back as refunds and is left out of both sides.` })
  }

  return out
}
