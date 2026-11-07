/**
 * Only the latest request may write state.
 *
 * A page that refetches on every filter, search and sort change has several
 * requests in flight at once, and they finish in any order: the Transactions
 * page showed the full ledger under the Review chip when an older fetch
 * (or an Undo toast's captured callback) landed last, and "Load more" then
 * appended rows that were already on screen. The fix is a token per request
 * and a check after every await: a response from a superseded request is
 * dropped, whatever it carries.
 *
 * Pure: no timers, no React.
 */
export function createSequence() {
  let current = 0
  return {
    /** Start a new request; the token it returns is current until the next call. */
    next() {
      current += 1
      return current
    },
    /** True while no newer request has started. */
    isCurrent(token) {
      return token === current
    },
    /** The latest token, for a caller that wants to compare by hand. */
    get current() {
      return current
    },
  }
}
