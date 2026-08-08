/**
 * Debt and rotating-savings maths.
 *
 * Ajo and esusu are the reason this module exists. A contribution logs as an
 * ordinary expense, and no amount of reading the ledger tells you which round
 * you are in or when the pot reaches you -- twelve identical debits look the
 * same whether the payout is next month or in September.
 */

export const DIRECTIONS = [
  { value: 'i_owe', label: 'I owe' },
  { value: 'owed_to_me', label: 'Owed to me' },
]

export const KINDS = [
  { value: 'loan', label: 'Loan', icon: '💳' },
  { value: 'ajo', label: 'Ajo', icon: '🤝' },
  { value: 'esusu', label: 'Esusu', icon: '🔄' },
]

export const isRotating = (kind) => kind === 'ajo' || kind === 'esusu'

/**
 * What is still outstanding on a loan.
 * @returns {number} never negative -- overpayment reads as settled, not as a debt owed back
 */
export function outstanding(debt) {
  return Math.max(0, (Number(debt?.principal) || 0) - (Number(debt?.amount_paid) || 0))
}

/**
 * Progress through a loan, 0..1.
 * @returns {number|null} null when there is no principal to measure against
 */
export function repaymentProgress(debt) {
  const principal = Number(debt?.principal) || 0
  if (principal <= 0) return null
  return Math.min(1, (Number(debt?.amount_paid) || 0) / principal)
}

/**
 * Where a rotating cycle stands.
 *
 * @returns {{position: number, size: number, roundsLeft: number, contributed: number, expectedPot: number}|null}
 */
export function cycleStatus(debt) {
  if (!isRotating(debt?.kind)) return null

  const size = Number(debt.cycle_size) || 0
  if (size <= 0) return null

  const position = Math.min(Math.max(Number(debt.cycle_position) || 1, 1), size)
  const contribution = Number(debt.contribution) || 0

  return {
    position,
    size,
    roundsLeft: size - position,
    contributed: contribution * position,
    // What you take home when the pot rotates to you: everyone pays in once
    // per round, including you.
    expectedPot: contribution * size,
  }
}

/**
 * Days until a date, from today. Negative means overdue.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {Date} [now]
 * @returns {number|null}
 */
export function daysUntil(dateStr, now = new Date()) {
  if (!dateStr) return null
  const target = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(target.getTime())) return null

  const midnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - midnightToday) / 86400000)
}

/**
 * Debts worth surfacing on Daily HQ: due or paying out inside the window, or
 * already overdue.
 *
 * @param {object[]} debts
 * @param {number} [withinDays]
 * @param {Date} [now]
 * @returns {Array<{debt: object, date: string, days: number, kind: 'due'|'payout'}>}
 */
export function upcomingDebts(debts, withinDays = 7, now = new Date()) {
  const items = []

  for (const debt of debts || []) {
    if (debt.settled) continue

    for (const [field, kind] of [['due_date', 'due'], ['payout_date', 'payout']]) {
      const days = daysUntil(debt[field], now)
      if (days === null) continue
      // Overdue items stay visible indefinitely; upcoming ones only inside the
      // window. A payment you missed last month should not quietly disappear.
      if (days <= withinDays) items.push({ debt, date: debt[field], days, kind })
    }
  }

  return items.sort((a, b) => a.days - b.days)
}

/**
 * Totals for the summary row. Rotating savings are counted at what you have
 * put in so far, not at the pot: the money is contributed, not owed.
 */
export function debtTotals(debts) {
  let iOwe = 0
  let owedToMe = 0
  let inCycles = 0

  for (const debt of debts || []) {
    if (debt.settled) continue

    if (isRotating(debt.kind)) {
      inCycles += cycleStatus(debt)?.contributed || 0
      continue
    }

    if (debt.direction === 'i_owe') iOwe += outstanding(debt)
    else owedToMe += outstanding(debt)
  }

  return { iOwe, owedToMe, inCycles }
}
