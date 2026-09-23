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
 * Which ledger direction repays a debt: money leaving for what I owe, money
 * arriving for what is owed to me.
 * @returns {'debit'|'credit'}
 */
export function repayingType(debt) {
  return debt?.direction === 'owed_to_me' ? 'credit' : 'debit'
}

/**
 * The ledger rows that count as repayment of this debt: linked to it, not
 * voided, and in the repaying direction. A voided row drops out here rather
 * than needing a reversal anywhere -- that is the point of deriving the
 * total instead of bumping `amount_paid` on every payment.
 *
 * @param {object[]} rows - transactions with at least debt_id, type, amount, voided
 * @param {object} debt
 */
export function linkedPayments(rows, debt) {
  if (!debt?.id) return []
  const type = repayingType(debt)
  return (rows || []).filter(
    (row) => row?.debt_id === debt.id && !row.voided && row.type === type,
  )
}

/**
 * Everything paid on a debt: the typed baseline (`amount_paid`, what was
 * paid before the ledger link existed) plus every linked repayment row.
 *
 * @param {object} debt
 * @param {object[]} [rows] - linked transactions, any debt's; filtered here
 */
export function paidTotal(debt, rows = []) {
  const baseline = Number(debt?.amount_paid) || 0
  return linkedPayments(rows, debt).reduce((sum, row) => sum + (Number(row.amount) || 0), baseline)
}

/** paidTotal for every debt at once, keyed by id. */
export function paidTotals(debts, rows = []) {
  const out = {}
  for (const debt of debts || []) {
    if (debt?.id) out[debt.id] = paidTotal(debt, rows)
  }
  return out
}

/** The paid figure a caller supplied, or the typed one on the row. */
function paidOr(debt, paid) {
  return paid == null ? Number(debt?.amount_paid) || 0 : Number(paid) || 0
}

/**
 * What is still outstanding on a loan.
 * @param {object} debt
 * @param {number} [paid] - total paid, when derived from the ledger; defaults to `amount_paid`
 * @returns {number} never negative -- overpayment reads as settled, not as a debt owed back
 */
export function outstanding(debt, paid) {
  return Math.max(0, (Number(debt?.principal) || 0) - paidOr(debt, paid))
}

/**
 * Progress through a loan, 0..1.
 * @param {object} debt
 * @param {number} [paid] - as for outstanding
 * @returns {number|null} null when there is no principal to measure against
 */
export function repaymentProgress(debt, paid) {
  const principal = Number(debt?.principal) || 0
  if (principal <= 0) return null
  return Math.min(1, paidOr(debt, paid) / principal)
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
 * When a loan reaches zero, at a flat monthly payment.
 *
 * No interest rate: these are personal loans, ajo and esusu, not bank credit
 * with a compounding balance, so principal minus a flat monthly amount is the
 * honest arithmetic rather than false precision this app has no rate to back
 * up. The payment is the caller's own plan (`debts.monthly_payment`), not
 * derived from anything else -- there is no "minimum payment" here to infer.
 *
 * @param {object} debt
 * @param {number} monthlyPayment
 * @param {Date} [now]
 * @param {number} [paid] - as for outstanding
 * @returns {{monthsRemaining: number, payoffDate: string} | null} null when
 *   there is a balance left but no payment to project it forward with
 */
export function payoffProjection(debt, monthlyPayment, now = new Date(), paid) {
  const remaining = outstanding(debt, paid)
  if (remaining <= 0) return { monthsRemaining: 0, payoffDate: dateOnly(now) }

  const payment = Number(monthlyPayment) || 0
  if (payment <= 0) return null

  const monthsRemaining = Math.ceil(remaining / payment)
  const target = new Date(now.getFullYear(), now.getMonth() + monthsRemaining, now.getDate())
  return { monthsRemaining, payoffDate: dateOnly(target) }
}

/** Local YYYY-MM-DD, kept in this module rather than importing queries.js so
 *  debts.js stays as dependency-free as it has been since it was written. */
function dateOnly(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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
 *
 * @param {object[]} debts
 * @param {Record<string, number>} [paidByDebt] - from paidTotals, when the
 *   ledger link is live; without it the typed amount_paid is used
 */
export function debtTotals(debts, paidByDebt = {}) {
  let iOwe = 0
  let owedToMe = 0
  let inCycles = 0

  for (const debt of debts || []) {
    if (debt.settled) continue

    if (isRotating(debt.kind)) {
      inCycles += cycleStatus(debt)?.contributed || 0
      continue
    }

    const left = outstanding(debt, paidByDebt[debt.id])
    if (debt.direction === 'i_owe') iOwe += left
    else owedToMe += left
  }

  return { iOwe, owedToMe, inCycles }
}
