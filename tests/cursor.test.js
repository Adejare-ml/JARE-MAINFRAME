import { describe, it, expect } from 'vitest'
import { nextCursor } from '../src/lib/sync/cursor.js'

const NOW = '2026-08-08T12:00:00.000Z'

const d = (iso) => new Date(iso).toISOString()

describe('nextCursor', () => {
  it('advances to the newest message handled', () => {
    const r = nextCursor({ newestProcessed: d('2026-08-08T09:00:00Z') }, NOW)

    expect(r.advance).toBe(true)
    expect(r.cursor).toBe(d('2026-08-08T09:00:00Z'))
  })

  // The bug this module exists for. Advancing to the OLDEST message pinned the
  // cursor at run one's oldest message: every later run re-read the same window
  // and recomputed the same minimum, so it never moved and the scan grew without
  // bound until it tripped the page limit for good.
  it('moves forward across runs instead of pinning at the oldest message', () => {
    // Run 1 handles a 25-day-old message and a 1-day-old one.
    const run1 = nextCursor({ newestProcessed: d('2026-08-07T00:00:00Z') }, NOW)
    // Run 2 sees the overlap plus something new.
    const run2 = nextCursor({ newestProcessed: d('2026-08-08T10:00:00Z') }, NOW)

    expect(run1.cursor < run2.cursor).toBe(true)
    expect(run2.cursor).toBe(d('2026-08-08T10:00:00Z'))
  })

  it('holds back to just before the oldest failure', () => {
    const r = nextCursor(
      {
        newestProcessed: d('2026-08-08T11:00:00Z'),
        oldestFailed: d('2026-08-08T08:00:00Z'),
        loopFailed: true,
      },
      NOW,
    )

    expect(r.advance).toBe(true)
    // One second behind, so the next window contains the failed message rather
    // than starting exactly on it.
    expect(r.cursor).toBe(d('2026-08-08T07:59:59Z'))
  })

  it('never pushes past what was handled when the failure is newer', () => {
    const r = nextCursor(
      {
        newestProcessed: d('2026-08-08T09:00:00Z'),
        oldestFailed: d('2026-08-08T11:00:00Z'),
        loopFailed: true,
      },
      NOW,
    )

    expect(r.cursor).toBe(d('2026-08-08T09:00:00Z'))
  })

  it('does not move at all when the page limit was hit', () => {
    // Gmail paginates newest-first, so truncation means the unseen messages are
    // the oldest ones and no value is safe.
    const r = nextCursor(
      { newestProcessed: d('2026-08-08T11:00:00Z'), truncated: true },
      NOW,
    )

    expect(r.advance).toBe(false)
    expect(r.cursor).toBeNull()
  })

  it('does not move when a message failed with no usable date', () => {
    const r = nextCursor(
      { newestProcessed: d('2026-08-08T11:00:00Z'), loopFailed: true, oldestFailed: null },
      NOW,
    )

    expect(r.advance).toBe(false)
  })

  // A run where every message was skipped -- all Opay mail on the manual path,
  // say -- used to land the cursor on `now` and step over everything it skipped.
  // Skips are now recorded as failures, so this shape cannot arise; if it ever
  // does, moving to now is correct because nothing was left behind.
  it('advances to now only when there was genuinely nothing to handle', () => {
    const r = nextCursor({ newestProcessed: null }, NOW)

    expect(r.advance).toBe(true)
    expect(r.cursor).toBe(NOW)
    expect(r.reason).toContain('nothing matched')
  })

  it('prefers holding back over advancing, on every combination', () => {
    for (const truncated of [true, false]) {
      for (const oldestFailed of [null, d('2026-08-08T08:00:00Z')]) {
        const r = nextCursor(
          { newestProcessed: d('2026-08-08T11:00:00Z'), oldestFailed, truncated, loopFailed: Boolean(oldestFailed) },
          NOW,
        )
        if (truncated) expect(r.advance).toBe(false)
        else if (oldestFailed) expect(r.cursor < d('2026-08-08T11:00:00Z')).toBe(true)
        else expect(r.cursor).toBe(d('2026-08-08T11:00:00Z'))
      }
    }
  })
})
