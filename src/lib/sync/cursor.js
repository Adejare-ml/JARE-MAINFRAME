/**
 * Deciding where the Gmail watermark lands after a run.
 *
 * This lives in its own module, tested, because the previous version of the
 * rule was wrong in a way that no test could see: it advanced `last_sync` to
 * the *oldest* message processed. Run one anchored the cursor at the oldest
 * message in the 30-day window; run two re-read that same window and computed
 * the same minimum, so it never moved. The scan grew every run until it
 * exceeded the page limit, at which point the cursor froze permanently.
 */

/** How far behind a failed message the cursor sits, so the retry window
 *  contains it rather than starting exactly on its boundary. */
const RETRY_MARGIN_MS = 1000

/**
 * Where `last_sync` should land after a sync run.
 *
 * @param {object} run
 * @param {string|null} run.newestProcessed - ISO date of the newest message handled
 * @param {string|null} run.oldestFailed - ISO date of the oldest message left unhandled
 * @param {boolean} run.truncated - the page limit was hit, so older messages were never listed
 * @param {boolean} run.loopFailed - at least one message failed
 * @param {string} [now] - injectable clock, for tests
 * @returns {{advance: boolean, cursor: string|null, reason: string}}
 */
export function nextCursor(
  { newestProcessed = null, oldestFailed = null, truncated = false, loopFailed = false },
  now = new Date().toISOString(),
) {
  // Gmail paginates newest-first, so hitting the page limit means the messages
  // we never saw are the OLDEST ones. Their dates are unknown, so there is no
  // safe value to move to.
  if (truncated) {
    return { advance: false, cursor: null, reason: 'page limit reached; older messages unseen' }
  }

  // Something failed before we could read its date, so we cannot tell whether
  // moving the cursor would step over it.
  if (loopFailed && !oldestFailed) {
    return { advance: false, cursor: null, reason: 'a message failed with no usable date' }
  }

  const target = newestProcessed || now

  if (oldestFailed) {
    const retryFrom = new Date(new Date(oldestFailed).getTime() - RETRY_MARGIN_MS).toISOString()
    // Only ever hold back, never push forward past what we handled.
    if (retryFrom < target) {
      return { advance: true, cursor: retryFrom, reason: 'held back to retry an unhandled message' }
    }
  }

  return {
    advance: true,
    cursor: target,
    reason: newestProcessed ? 'advanced to newest handled' : 'nothing matched; advanced to now',
  }
}
