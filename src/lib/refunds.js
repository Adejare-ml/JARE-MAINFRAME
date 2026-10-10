/**
 * A refund is not income.
 *
 * A reversed POS charge, a failed transfer bounced back, a cancelled order:
 * each lands as a credit on the same wallet for exactly the amount that
 * left days earlier. Counted as it stands, the month shows both a purchase
 * that never happened and income that was never earned, and the budget
 * pace is wrong in both directions. This pairs each such credit with its
 * debit so a caller can leave both legs out of the totals.
 *
 * A match needs all of: same wallet; equal amount; the credit dated on or
 * after the debit, within `windowDays`; and either the credit's text says
 * refund/reversal, or the two rows share a payee word. Equal amounts alone
 * are not enough -- ₦5,000 out to a friend and ₦5,000 in from a client the
 * same week is two transactions, not one undone. Own-account transfers
 * (TRANSFER_CATEGORIES) are never refunds; summarizeMonth already keeps
 * them out of spending.
 *
 * Pure. Rows need id, type, amount, wallet_id, transaction_date, and
 * recipient/description for the payee test (transactionRecurrenceColumns).
 */
import { TRANSFER_CATEGORIES } from './summary.js'

/** How many days after a debit its refund may still land. */
export const REFUND_WINDOW_DAYS = 14

const REFUND_WORDS = /\b(refund|refunded|reversal|reversed|rvsl|rev\b|chargeback|bounce[d]?)\b/i

/** Words of three letters or more, lowercased, from the payee or narration. */
function payeeWords(t) {
  const text = `${t?.recipient || ''} ${t?.description || ''}`.toLowerCase()
  return new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))
}
const STOP = new Set(['the', 'and', 'for', 'from', 'transfer', 'payment', 'purchase', 'pos', 'web', 'nip', 'ussd', 'trf'])

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000)
}

function usable(t) {
  return t && !t.voided && Number(t.amount) > 0 && !TRANSFER_CATEGORIES.includes(t.category)
}

/**
 * Pair credits with the debits they undo.
 *
 * @param {object[]} transactions
 * @param {{windowDays?: number}} [options]
 * @returns {Array<{debit: object, credit: object, reason: 'text'|'payee'}>}
 */
export function matchRefunds(transactions = [], { windowDays = REFUND_WINDOW_DAYS } = {}) {
  const rows = (transactions || []).filter(usable)
  const debits = rows.filter((t) => t.type === 'debit').sort((a, b) => (a.transaction_date < b.transaction_date ? -1 : 1))
  const credits = rows.filter((t) => t.type === 'credit').sort((a, b) => (a.transaction_date < b.transaction_date ? -1 : 1))
  const taken = new Set()
  const matches = []

  for (const credit of credits) {
    const says = REFUND_WORDS.test(`${credit.recipient || ''} ${credit.description || ''}`)
    const creditWords = payeeWords(credit)
    let best = null
    for (const debit of debits) {
      if (taken.has(debit.id)) continue
      if (debit.wallet_id !== credit.wallet_id) continue
      if (Number(debit.amount) !== Number(credit.amount)) continue
      const gap = daysBetween(debit.transaction_date, credit.transaction_date)
      if (gap < 0 || gap > windowDays) continue
      let reason = null
      if (says) reason = 'text'
      else {
        for (const w of payeeWords(debit)) {
          if (creditWords.has(w)) { reason = 'payee'; break }
        }
      }
      if (!reason) continue
      // The latest qualifying debit: a refund undoes the most recent charge.
      if (!best || debit.transaction_date > best.debit.transaction_date) best = { debit, credit, reason }
    }
    if (best) {
      taken.add(best.debit.id)
      matches.push(best)
    }
  }
  return matches
}

/**
 * The rows with every matched pair removed, and what was removed.
 *
 * @param {object[]} transactions
 * @param {{windowDays?: number}} [options]
 * @returns {{rows: object[], refunds: Array<{debit: object, credit: object, reason: string}>, netted: number}}
 */
export function excludeRefunded(transactions = [], options = {}) {
  const refunds = matchRefunds(transactions, options)
  if (refunds.length === 0) return { rows: transactions || [], refunds, netted: 0 }
  const drop = new Set()
  let netted = 0
  for (const { debit, credit } of refunds) {
    drop.add(debit.id)
    drop.add(credit.id)
    netted += Number(credit.amount)
  }
  return { rows: (transactions || []).filter((t) => !drop.has(t.id)), refunds, netted }
}
