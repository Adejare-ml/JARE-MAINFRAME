/**
 * Correcting a transaction the parser (or a fat finger) got wrong.
 *
 * The pure parts live here so they can be tested without a database: what
 * counts as a valid correction, and how to recognise the one error that must
 * not be fatal.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * Check an edited transaction before it is written.
 *
 * Validated on the client *and* in the RPC. Not redundancy for its own sake:
 * the client check is what turns a mistake into a sentence the user can act on
 * instead of a Postgres exception, and the server check is what makes the rule
 * true regardless of which client wrote the row.
 *
 * @param {{type: string, amount: string|number, date: string}} fields
 * @returns {{ok: true, value: {type: string, amount: number, date: string}} | {ok: false, error: string}}
 */
export function validateCorrection(fields) {
  const { type, amount, date } = fields || {}

  if (type !== 'debit' && type !== 'credit') {
    return { ok: false, error: 'Pick whether money went out or came in' }
  }

  // Number('') is 0 and Number(' ') is 0, so an empty box would sail through a
  // bare `Number(x) > 0` check on the trimmed string alone.
  const parsed = typeof amount === 'number' ? amount : Number(String(amount ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false, error: 'Amount must be a number greater than zero' }
  }

  if (typeof date !== 'string' || !DATE_ONLY.test(date)) {
    return { ok: false, error: 'Pick a valid date' }
  }
  // <input type="date"> cannot produce 2026-02-31, but a hand-typed value or a
  // browser without the native picker can.
  const [y, m, d] = date.split('-').map(Number)
  const asDate = new Date(y, m - 1, d)
  if (asDate.getFullYear() !== y || asDate.getMonth() !== m - 1 || asDate.getDate() !== d) {
    return { ok: false, error: 'That date does not exist' }
  }

  // Round to kobo. A number input will happily hand back 1200.9999999999998
  // after arithmetic in some locales, and the ledger stores naira and kobo.
  return { ok: true, value: { type, amount: Math.round(parsed * 100) / 100, date } }
}

/**
 * True when the error means "that function is not in the database".
 *
 * Worth recognising because the app deploys the moment a commit lands on main,
 * while migrations are run by hand afterwards. In the window between the two,
 * an edit should still save what it can rather than failing outright.
 *
 * PGRST202 is PostgREST's "no function matches"; 42883 is Postgres' own
 * undefined_function, which surfaces when the schema cache is warm but the
 * function was dropped.
 *
 * The message pattern names `function` deliberately. A bare /does not exist/
 * also matches `column transactions.explanation does not exist` -- the error
 * that took production down -- and a missing column routed into the
 * missing-function fallback would take a recovery path built for a different
 * problem, then fail again on the way out. Use isMissingColumnError in
 * src/lib/schema.js for that case.
 *
 * @param {{code?: string, message?: string}} error
 * @returns {boolean}
 */
export function isMissingFunctionError(error) {
  if (!error) return false
  if (error.code === 'PGRST202' || error.code === '42883') return true
  return /could not find the function|function .* does not exist/i.test(error.message || '')
}

/**
 * The signed effect a row has on its wallet balance.
 *
 * Only meaningful for manual rows: those move the wallet balance at insert
 * time, so an edit has to move it by the difference. A synced row's balance
 * comes from the bank's own alert and is never derived from our arithmetic.
 *
 * Mirrors the `correct_transaction` RPC so the expected delta can be asserted
 * in a test without standing up Postgres.
 *
 * @param {{type: string, amount: number|string, voided?: boolean}} txn
 * @returns {number}
 */
export function signedEffect(txn) {
  if (!txn || txn.voided) return 0
  const amount = Number(txn.amount) || 0
  return txn.type === 'credit' ? amount : -amount
}

/**
 * How much a wallet balance must move when `before` becomes `after`.
 *
 * @param {object} before
 * @param {object} after
 * @returns {number}
 */
export function balanceDelta(before, after) {
  return signedEffect(after) - signedEffect(before)
}
