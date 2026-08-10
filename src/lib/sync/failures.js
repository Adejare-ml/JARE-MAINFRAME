/**
 * How many times a single message may hold the Gmail watermark back.
 *
 * Holding the cursor for a failed message is right: a transient LLM outage, a
 * bank sending from a new domain, a dropped connection -- all of them look
 * identical to a permanent failure at the moment they happen, and losing a real
 * transaction is worse than re-reading one email.
 *
 * Holding it *forever* is not. Two Opay alerts that no model could parse pinned
 * `last_sync` at 2026-08-05 across every subsequent run: each run re-fetched the
 * same window, failed the same two messages, and recomputed the same watermark.
 * Nothing was lost and nothing was duplicated -- the ledger stayed correct --
 * but the scan window was anchored to a fixed date while the calendar moved, so
 * the cost of a run grew without bound. A month on, six runs a day would each
 * re-read a month of email and re-spend the model calls to conclude what the
 * run before it concluded.
 *
 * So a failure is retried, then given up on: recorded, reported, and allowed to
 * pass under the cursor. The count is per message and persists across runs,
 * because "has this failed before" is not a question a single run can answer.
 */

/** Roughly a day of retries at four scheduled runs a day. Long enough that a
 *  provider outage resolves on its own; short enough that a permanently
 *  unreadable email stops costing anything by tomorrow. */
export const MAX_ATTEMPTS = 5

/**
 * The per-message failure record, held in memory for a run and flushed once.
 *
 * Deliberately knows nothing about Supabase: the script hands it the rows it
 * loaded and asks it for the rows to write back, which is what makes every rule
 * below testable without a database.
 */
export class FailureLedger {
  /**
   * @param {Array<{message_id: string, attempts: number}>} rows - existing records
   * @param {number} [max] - attempts before giving up
   */
  constructor(rows = [], max = MAX_ATTEMPTS) {
    this.max = max
    this.records = new Map()
    this.dirty = new Set()
    this.cleared = new Set()

    for (const row of rows || []) {
      if (!row?.message_id) continue
      this.records.set(row.message_id, {
        message_id: row.message_id,
        attempts: Number(row.attempts) || 0,
        source: row.source ?? null,
        message_date: row.message_date ?? null,
        last_error: row.last_error ?? null,
      })
    }
  }

  /** Attempts recorded before this run. */
  attemptsFor(messageId) {
    return this.records.get(messageId)?.attempts || 0
  }

  /**
   * Record one more failure and report whether the cursor should still be held
   * for this message.
   *
   * @returns {{attempts: number, giveUp: boolean}}
   */
  recordFailure(messageId, { reason = null, date = null, source = null } = {}) {
    if (!messageId) return { attempts: 0, giveUp: false }

    const existing = this.records.get(messageId)
    const attempts = (existing?.attempts || 0) + 1

    this.records.set(messageId, {
      message_id: messageId,
      attempts,
      // Keep the first values seen: a later run that fails earlier in the
      // pipeline should not erase what the first one managed to learn.
      source: source ?? existing?.source ?? null,
      message_date: date ?? existing?.message_date ?? null,
      last_error: reason ?? existing?.last_error ?? null,
    })
    this.dirty.add(messageId)
    this.cleared.delete(messageId)

    return { attempts, giveUp: attempts >= this.max }
  }

  /** True once this message has burned through its retries. */
  hasGivenUp(messageId) {
    return this.attemptsFor(messageId) >= this.max
  }

  /**
   * A message that finally worked. Its history is dropped rather than kept at
   * zero -- otherwise a provider outage that resolved leaves a permanent record
   * of a problem that no longer exists, and the table becomes noise nobody
   * reads.
   */
  recordSuccess(messageId) {
    if (!messageId) return
    this.dirty.delete(messageId)
    if (this.records.delete(messageId)) this.cleared.add(messageId)
  }

  /** Rows to upsert. Empty when nothing failed, which is the common case. */
  pendingWrites() {
    return [...this.dirty].map((id) => {
      const r = this.records.get(id)
      return {
        message_id: r.message_id,
        attempts: r.attempts,
        source: r.source,
        message_date: r.message_date,
        last_error: r.last_error,
        gave_up: r.attempts >= this.max,
        last_failed_at: new Date().toISOString(),
      }
    })
  }

  /** Message ids whose records should be deleted, having since succeeded. */
  pendingDeletes() {
    return [...this.cleared]
  }

  /** Everything currently past the retry limit, for the run report. */
  givenUp() {
    return [...this.records.values()]
      .filter((r) => r.attempts >= this.max)
      .sort((a, b) => String(a.message_date).localeCompare(String(b.message_date)))
  }
}
