/**
 * Which two categories a move between your own wallets is filed under.
 *
 * summarizeMonth counts spending and income only from rows whose category is
 * not in TRANSFER_CATEGORIES, so a transfer's two legs must both land in
 * that list or moving money to PiggyVest reads as spending it and the
 * matching credit reads as pay. The pair is chosen by where the money is
 * going: the existing vocabulary already has names for "into savings" and
 * "out as cash", and everything else gets the generic pair.
 */

import { TRANSFER_CATEGORIES } from './summary.js'

export const TRANSFER_OUT = 'Transfer Out'
export const TRANSFER_IN = 'Transfer In'

/**
 * @param {{type?: string}|null} from
 * @param {{type?: string}|null} to
 * @returns {[string, string]} [debit category on `from`, credit category on `to`]
 */
export function transferCategories(from, to) {
  const toType = to?.type
  if (toType === 'savings') return ['Savings Transfer', 'Savings']
  if (toType === 'investment') return ['Savings Transfer', 'Investment']
  if (toType === 'cash' && from?.type !== 'cash') return ['Cash Withdrawal', 'Cash Received']
  return [TRANSFER_OUT, TRANSFER_IN]
}

/** Every pair transferCategories can return is a transfer, by construction. */
export function isTransferPair([debit, credit]) {
  return TRANSFER_CATEGORIES.includes(debit) && TRANSFER_CATEGORIES.includes(credit)
}

/**
 * What stops a transfer before it is sent.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateTransfer({ from, to, amount }) {
  const value = Number(amount)
  if (!from || !to) return { ok: false, error: 'Pick both wallets' }
  if (from.id === to.id) return { ok: false, error: 'Pick two different wallets' }
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'Enter an amount above zero' }
  return { ok: true }
}
