import { describe, it, expect } from 'vitest'
import { FailureLedger, MAX_ATTEMPTS } from '../src/lib/sync/failures.js'
import { nextCursor } from '../src/lib/sync/cursor.js'

/**
 * The bug this file exists for, end to end.
 *
 * Two Opay alerts no model could read held `last_sync` at 2026-08-05 across
 * every run that followed. Each run re-fetched the same window, failed the same
 * two messages, and recomputed the same watermark. Nothing was lost -- but the
 * window was anchored to a fixed date while the calendar moved, so the cost of
 * a run grew without bound.
 *
 * This replays it: one message that always fails, one that always succeeds,
 * with the ledger persisting across runs the way the table does.
 */
function simulateRuns(count, { failAt, succeedAt }) {
  let rows = []
  const cursors = []

  for (let run = 0; run < count; run++) {
    const ledger = new FailureLedger(rows)
    let newestProcessed = null
    let oldestFailed = null
    let loopFailed = false

    // The message that always parses.
    newestProcessed = succeedAt

    // The message that never does.
    const { giveUp } = ledger.recordFailure('unreadable', { date: failAt })
    if (giveUp) {
      if (failAt > newestProcessed) newestProcessed = failAt
    } else {
      loopFailed = true
      oldestFailed = failAt
    }

    cursors.push(nextCursor({ newestProcessed, oldestFailed, loopFailed }))

    // Persist, as flushFailureLedger would.
    const writes = ledger.pendingWrites()
    rows = rows.filter((r) => !writes.some((w) => w.message_id === r.message_id)).concat(writes)
  }

  return cursors
}

describe('the pinned cursor, replayed', () => {
  const failAt = '2026-08-05T07:48:33.000Z'
  const succeedAt = '2026-08-09T12:00:00.000Z'

  it('holds the watermark while retries remain, then releases it', () => {
    const cursors = simulateRuns(MAX_ATTEMPTS + 2, { failAt, succeedAt })

    // Early runs behave exactly as before: pinned just behind the bad message.
    for (const c of cursors.slice(0, MAX_ATTEMPTS - 1)) {
      expect(c.reason).toBe('held back to retry an unhandled message')
      expect(c.cursor).toBe('2026-08-05T07:48:32.000Z')
    }

    // The run that exhausts the retries lets the cursor past.
    expect(cursors[MAX_ATTEMPTS - 1].cursor).toBe(succeedAt)

    // And it stays past -- the old behaviour would have re-pinned it here.
    expect(cursors[MAX_ATTEMPTS].cursor).toBe(succeedAt)
    expect(cursors[MAX_ATTEMPTS + 1].cursor).toBe(succeedAt)
  })

  it('never moves the cursor backwards once it has been released', () => {
    const cursors = simulateRuns(MAX_ATTEMPTS + 3, { failAt, succeedAt })
    const released = cursors.slice(MAX_ATTEMPTS - 1).map((c) => c.cursor)
    expect(released.every((c) => c === succeedAt)).toBe(true)
  })

  it('without the ledger, the cursor stays pinned forever -- the original bug', () => {
    // The control case. Each run starting from an empty ledger is what "count
    // only this run's attempts" would do, and it reproduces the freeze.
    const cursors = Array.from({ length: MAX_ATTEMPTS + 3 }, () =>
      simulateRuns(1, { failAt, succeedAt })[0],
    )
    expect(cursors.every((c) => c.cursor === '2026-08-05T07:48:32.000Z')).toBe(true)
  })
})

describe('FailureLedger', () => {
  it('holds the cursor for the first failure', () => {
    const ledger = new FailureLedger()
    expect(ledger.recordFailure('m1', { reason: 'llm down' })).toEqual({
      attempts: 1,
      giveUp: false,
    })
  })

  it('counts across runs, not just within one', () => {
    // The entire point. A run that only counted its own attempts would report
    // 1 every time and never reach the limit -- which is the original bug with
    // extra bookkeeping.
    const ledger = new FailureLedger([{ message_id: 'm1', attempts: MAX_ATTEMPTS - 1 }])
    expect(ledger.recordFailure('m1')).toEqual({ attempts: MAX_ATTEMPTS, giveUp: true })
  })

  it('gives up only at the limit, never before', () => {
    const ledger = new FailureLedger()
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(ledger.recordFailure('m1').giveUp).toBe(false)
    }
    expect(ledger.recordFailure('m1').giveUp).toBe(true)
  })

  it('keeps two messages independent', () => {
    // One unreadable email must not exhaust the retries of an unrelated one
    // that failed once during the same outage.
    const ledger = new FailureLedger([{ message_id: 'bad', attempts: MAX_ATTEMPTS }])
    expect(ledger.hasGivenUp('bad')).toBe(true)
    expect(ledger.recordFailure('fresh').giveUp).toBe(false)
  })

  it('forgets a message that finally succeeded', () => {
    // A resolved outage should leave no record, or the table accumulates
    // problems that no longer exist and stops being worth reading.
    const ledger = new FailureLedger([{ message_id: 'm1', attempts: 3 }])
    ledger.recordSuccess('m1')

    expect(ledger.attemptsFor('m1')).toBe(0)
    expect(ledger.pendingDeletes()).toEqual(['m1'])
    expect(ledger.pendingWrites()).toEqual([])
  })

  it('does not queue a delete for a message it never knew about', () => {
    const ledger = new FailureLedger()
    ledger.recordSuccess('never-failed')
    expect(ledger.pendingDeletes()).toEqual([])
  })

  it('a later failure cancels an earlier success in the same run', () => {
    // Belt and braces: the same id cannot be queued for both an upsert and a
    // delete, which would make the outcome depend on which statement ran last.
    const ledger = new FailureLedger([{ message_id: 'm1', attempts: 1 }])
    ledger.recordSuccess('m1')
    ledger.recordFailure('m1')

    expect(ledger.pendingDeletes()).toEqual([])
    expect(ledger.pendingWrites()).toHaveLength(1)
  })

  it('writes nothing when nothing failed -- the common case', () => {
    const ledger = new FailureLedger([{ message_id: 'old', attempts: 2 }])
    expect(ledger.pendingWrites()).toEqual([])
    expect(ledger.pendingDeletes()).toEqual([])
  })

  it('carries the first context forward rather than overwriting it', () => {
    // A later run that fails earlier in the pipeline knows less than the first
    // one did. Losing the date would leave a record nobody can trace back to an
    // email.
    const ledger = new FailureLedger()
    ledger.recordFailure('m1', { date: '2026-08-05T07:48:33.000Z', source: 'opay' })
    ledger.recordFailure('m1', {})

    const [row] = ledger.pendingWrites()
    expect(row.message_date).toBe('2026-08-05T07:48:33.000Z')
    expect(row.source).toBe('opay')
    expect(row.attempts).toBe(2)
  })

  it('marks gave_up on the row it writes, so SQL can answer without the constant', () => {
    const ledger = new FailureLedger([{ message_id: 'm1', attempts: MAX_ATTEMPTS - 1 }])
    ledger.recordFailure('m1')
    expect(ledger.pendingWrites()[0].gave_up).toBe(true)
  })

  it('ignores a missing message id rather than counting a null', () => {
    // Fetch failures have no id to count against; they must not all collide on
    // one phantom record and exhaust each other's retries.
    const ledger = new FailureLedger()
    expect(ledger.recordFailure(null)).toEqual({ attempts: 0, giveUp: false })
    expect(ledger.pendingWrites()).toEqual([])
  })

  it('survives junk rows from the database', () => {
    const ledger = new FailureLedger([{ message_id: 'm1' }, {}, null, { attempts: 3 }])
    expect(ledger.attemptsFor('m1')).toBe(0)
    expect(ledger.recordFailure('m1').attempts).toBe(1)
  })

  it('lists what it has given up on, oldest first', () => {
    const ledger = new FailureLedger([
      { message_id: 'new', attempts: MAX_ATTEMPTS, message_date: '2026-08-05T00:00:00.000Z' },
      { message_id: 'old', attempts: MAX_ATTEMPTS, message_date: '2026-08-01T00:00:00.000Z' },
      { message_id: 'trying', attempts: 1, message_date: '2026-08-03T00:00:00.000Z' },
    ])
    expect(ledger.givenUp().map((r) => r.message_id)).toEqual(['old', 'new'])
  })

  it('honours a custom limit', () => {
    const ledger = new FailureLedger([], 2)
    expect(ledger.recordFailure('m1').giveUp).toBe(false)
    expect(ledger.recordFailure('m1').giveUp).toBe(true)
  })
})
