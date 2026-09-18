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
 * `voice` picks which of two fixed phrasings for that same branch is shown --
 * a Cleo-style tough-love option next to the default -- never which branch
 * fires. Which fact applies is still decided by the numbers alone; `voice`
 * only changes how the true thing is said.
 *
 * @param {object} facts
 * @param {Array<{name: string, balance: number}>} [facts.lowWallets]
 * @param {Array<{debt: {counterparty: string}, days: number}>} [facts.overdueDebts]
 * @param {number} [facts.totalSpent] - this month, transfers excluded
 * @param {number|null} [facts.budgetTarget]
 * @param {{aheadBy: number, onTrack: boolean}|null} [facts.pace] - from summary.js budgetPace()
 * @param {number} [facts.streak] - from activity.js currentStreak()
 * @param {number} [facts.safeToSpendToday]
 * @param {'encouraging'|'stern'} [facts.voice]
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
  voice = 'encouraging',
} = {}) {
  const stern = voice === 'stern'

  if (lowWallets.length > 0) {
    const w = lowWallets[0]
    const balance = formatNaira(w.balance)
    return {
      text: stern
        ? `${w.name} is nearly empty — ${balance} left. Stop spending from it.`
        : `${w.name} is running low — ${balance} left.`,
      tone: 'warn',
    }
  }

  if (overdueDebts.length > 0) {
    const { debt, days } = overdueDebts[0]
    const n = Math.abs(days)
    const nDays = `${n} day${n === 1 ? '' : 's'}`
    return {
      text: stern
        ? `You're ${nDays} late paying ${debt.counterparty}. Sort it today.`
        : `A payment to ${debt.counterparty} is ${nDays} overdue.`,
      tone: 'warn',
    }
  }

  if (budgetTarget > 0 && totalSpent > budgetTarget) {
    const over = formatNaira(totalSpent - budgetTarget)
    return {
      text: stern ? `You blew the budget by ${over}. No more spending this month.` : `${over} over this month's budget already.`,
      tone: 'warn',
    }
  }

  if (pace && !pace.onTrack) {
    const ahead = formatNaira(pace.aheadBy)
    return {
      text: stern
        ? `You're spending too fast — ${ahead} ahead of pace. Slow down.`
        : `${ahead} ahead of pace this month — ease off to land on budget.`,
      tone: 'watch',
    }
  }

  if (streak >= 3) {
    return {
      text: stern ? `${streak}-day streak. Don't blow it today.` : `${streak}-day streak — keep it going today.`,
      tone: 'good',
    }
  }

  if (safeToSpendToday <= 0) {
    return {
      text: stern ? 'Zero safe to spend. Put the card away.' : 'Nothing safe to spend today until something frees up.',
      tone: 'watch',
    }
  }

  if (budgetTarget > 0 && pace && pace.onTrack) {
    const safe = formatNaira(safeToSpendToday)
    return {
      text: stern ? `On pace, for now. ${safe} safe to spend — don't test it.` : `On pace this month. ${safe} safe to spend today.`,
      tone: 'good',
    }
  }

  return {
    text: stern ? 'Nothing pressing. Stay sharp anyway.' : 'A clean slate — nothing pressing today.',
    tone: 'neutral',
  }
}
