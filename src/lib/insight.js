import { formatNaira } from './formatters.js'

/**
 * One proactive, plain-language sentence about today.
 *
 * The deterministic ancestor of Stage E's evidence-grounded recap, and built
 * on the same discipline in miniature: every sentence here is picked from a
 * fixed list, and each one maps straight onto a number already computed
 * elsewhere on Daily HQ (summary.js, debts.js, activity.js). There is
 * nothing generative in this file -- no model, no free text -- so there is
 * nothing here that could misstate what actually happened. That is the
 * point: this is what a recap can say honestly before Stage E's citation
 * gating exists to check a model's account of the same day.
 *
 * One insight, not a feed of them. Daily HQ has room for a single sentence
 * at the top, and ranking what to say is more useful than a list nobody
 * reads past the first line. Checked in priority order: what needs a
 * decision today outranks what is merely informative.
 *
 * @param {object} facts
 * @param {Array<{name: string, balance: number}>} [facts.lowWallets]
 * @param {Array<{debt: {counterparty: string}, days: number}>} [facts.overdueDebts]
 * @param {number} [facts.totalSpent] - this month, transfers excluded
 * @param {number|null} [facts.budgetTarget]
 * @param {{aheadBy: number, onTrack: boolean}|null} [facts.pace] - from summary.js budgetPace()
 * @param {number} [facts.streak] - from activity.js currentStreak()
 * @param {number} [facts.safeToSpendToday]
 * @returns {{text: string, tone: 'warn'|'watch'|'good'|'neutral'}}
 */
export function dailyInsight({
  lowWallets = [],
  overdueDebts = [],
  totalSpent = 0,
  budgetTarget = null,
  pace = null,
  streak = 0,
  safeToSpendToday = 0,
} = {}) {
  if (lowWallets.length > 0) {
    const w = lowWallets[0]
    return { text: `${w.name} is running low — ${formatNaira(w.balance)} left.`, tone: 'warn' }
  }

  if (overdueDebts.length > 0) {
    const { debt, days } = overdueDebts[0]
    const n = Math.abs(days)
    return {
      text: `A payment to ${debt.counterparty} is ${n} day${n === 1 ? '' : 's'} overdue.`,
      tone: 'warn',
    }
  }

  if (budgetTarget > 0 && totalSpent > budgetTarget) {
    return { text: `${formatNaira(totalSpent - budgetTarget)} over this month's budget already.`, tone: 'warn' }
  }

  if (pace && !pace.onTrack) {
    return {
      text: `${formatNaira(pace.aheadBy)} ahead of pace this month — ease off to land on budget.`,
      tone: 'watch',
    }
  }

  if (streak >= 3) {
    return { text: `${streak}-day streak — keep it going today.`, tone: 'good' }
  }

  if (safeToSpendToday <= 0) {
    return { text: 'Nothing safe to spend today until something frees up.', tone: 'watch' }
  }

  if (budgetTarget > 0 && pace && pace.onTrack) {
    return { text: `On pace this month. ${formatNaira(safeToSpendToday)} safe to spend today.`, tone: 'good' }
  }

  return { text: 'A clean slate — nothing pressing today.', tone: 'neutral' }
}
