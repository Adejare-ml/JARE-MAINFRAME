import { describe, it, expect, afterEach, vi } from 'vitest'
import { assertProgress } from '../scripts/lib/assertProgress.mjs'

/**
 * The whole point of this module is the exit code, so exitCode is what every
 * test reads back -- not a return value, since the caller never gets one.
 */
afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('assertProgress', () => {
  it('leaves the exit code alone when every check passes', () => {
    assertProgress([
      { ok: true, reason: 'unreachable' },
      { ok: true, reason: 'also unreachable' },
    ])
    expect(process.exitCode).toBeUndefined()
  })

  it('is a no-op on an empty check list', () => {
    // A script with nothing worth asserting this run (an early-return path,
    // say) should not have to invent a check just to call this safely.
    assertProgress([])
    expect(process.exitCode).toBeUndefined()
  })

  it('fails the run on a single failed check', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    assertProgress([{ ok: false, reason: 'no messages were processed' }])
    expect(process.exitCode).toBe(1)
  })

  it('prints every failed reason, not just the first', () => {
    const logs = []
    vi.spyOn(console, 'log').mockImplementation((line) => logs.push(line))

    assertProgress([
      { ok: false, reason: 'reason one' },
      { ok: true, reason: 'irrelevant' },
      { ok: false, reason: 'reason two' },
    ])

    expect(logs.some((l) => l.includes('reason one'))).toBe(true)
    expect(logs.some((l) => l.includes('reason two'))).toBe(true)
    expect(logs.some((l) => l.includes('irrelevant'))).toBe(false)
  })

  it('does not throw, so a script can call it and keep running to its own end', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(() => assertProgress([{ ok: false, reason: 'x' }])).not.toThrow()
  })
})
