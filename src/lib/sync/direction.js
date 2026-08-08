/**
 * Working out whether money came in or went out.
 *
 * Some providers never say. Opay describes money in and money out with the same
 * word ("transfer"), so every keyword rule mislabels roughly half of them — and
 * a wrong direction silently corrupts the monthly totals.
 *
 * But those alerts always state the available balance afterwards. Comparing it
 * against the balance before the alert settles the question by arithmetic,
 * which beats asking a language model to infer it from prose.
 */

/** Balances are money, so compare to the kobo and no finer. Guards against a
 *  parser producing 5808.089999999999 and reading it as a movement. */
const EPSILON = 0.005

/**
 * Decide direction from how the balance moved.
 *
 * Returns null — meaning "cannot tell, ask something else" — in the two cases
 * where the arithmetic genuinely has no answer: no prior balance to compare
 * against (the first alert ever seen for a wallet), and a balance that did not
 * move (rare, but real: a reversed charge, or two alerts for one event).
 *
 * @param {number|string|null} newBalance - balance stated in this alert
 * @param {number|string|null|undefined} priorBalance - balance before it
 * @returns {{type: 'debit'|'credit', confidence: 'HIGH'}|null}
 */
export function directionFromBalance(newBalance, priorBalance) {
  const next = Number(newBalance)
  const prev = Number(priorBalance)

  if (newBalance == null || !Number.isFinite(next)) return null
  if (priorBalance == null || !Number.isFinite(prev)) return null

  const delta = next - prev
  if (Math.abs(delta) < EPSILON) return null

  // HIGH without qualification: this is subtraction, not inference.
  return { type: delta < 0 ? 'debit' : 'credit', confidence: 'HIGH' }
}

/**
 * Does this parse already know its own direction?
 *
 * Only `direction_source: 'label'` counts — the email said DEBIT or CREDIT in
 * so many words. A keyword guess ('guess') and the model's inference ('llm')
 * both defer to balance movement, because subtraction beats inference and the
 * spec is explicit that arithmetic wins wherever a prior balance exists.
 *
 * Deliberately not keyed on `confidence`: that field describes how sure the
 * parser is about the *category*, and conflating the two meant a GTBank alert
 * with an explicit DEBIT label was re-derived from balance movement whenever
 * its category happened to be uncertain.
 *
 * @param {object|null} parsed
 * @returns {boolean}
 */
export function hasReliableDirection(parsed) {
  if (!parsed?.type) return false
  return parsed.direction_source === 'label'
}

/**
 * Track each wallet's balance as a batch is processed in chronological order.
 *
 * Seeded lazily from the wallet's stored balance, then advanced by every alert
 * carrying one — including alerts that turn out to be duplicates and are not
 * inserted. That last part is what makes the re-scan overlap safe: the first
 * message of each window is usually one we have already seen, and it must still
 * move the chain forward so the message after it compares against the right
 * predecessor.
 */
export class BalanceChain {
  constructor(wallets = []) {
    this.stored = new Map((wallets || []).map((w) => [w.id, w]))
    this.running = new Map()
  }

  /**
   * The balance immediately before this wallet's next alert, or null if unknown.
   * @param {string} walletId
   * @returns {number|null}
   */
  priorFor(walletId) {
    if (this.running.has(walletId)) return this.running.get(walletId)

    const stored = this.stored.get(walletId)?.balance
    const value = Number(stored)
    return stored == null || !Number.isFinite(value) ? null : value
  }

  /**
   * Record the balance an alert reported, whether or not its row was inserted.
   * @param {string} walletId
   * @param {number|string|null} balance
   */
  observe(walletId, balance) {
    if (!walletId || balance == null) return
    const value = Number(balance)
    if (Number.isFinite(value)) this.running.set(walletId, value)
  }
}

/**
 * Sort messages oldest-first.
 *
 * Gmail lists newest-first, which is exactly backwards for a balance chain:
 * each comparison needs the alert before it, not after.
 *
 * @param {Array<{internalDate?: string|number}>} messages
 * @returns {Array} a new array; the input is not mutated
 */
export function sortChronologically(messages) {
  return [...(messages || [])].sort((a, b) => {
    const at = Number(a?.internalDate) || 0
    const bt = Number(b?.internalDate) || 0
    return at - bt
  })
}
