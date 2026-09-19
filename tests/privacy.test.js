import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isZenEnabled, setZenEnabled, applyZenPreference } from '../src/lib/privacy.js'

/**
 * Mirrors tests/theme.test.js exactly -- privacy.js is deliberately the same
 * shape (localStorage + document.dataset), for the same per-device,
 * before-first-paint reasoning. See that file's header comment for why each
 * global needs stubbing under Vitest's default Node environment.
 */

function memoryStorage() {
  const store = new Map()
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  }
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error('storage blocked')
    },
    setItem: () => {
      throw new Error('storage blocked')
    },
  }
}

describe('privacy (Zen mode preference)', () => {
  let doc

  beforeEach(() => {
    doc = { documentElement: { dataset: {} } }
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('document', doc)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('defaults to disabled before anything is stored', () => {
    expect(isZenEnabled()).toBe(false)
  })

  it('round-trips through the setter -- the stored string is exactly what the getter compares against', () => {
    setZenEnabled(true)
    expect(localStorage.getItem('zen_mode')).toBe('true')
    expect(isZenEnabled()).toBe(true)

    setZenEnabled(false)
    expect(localStorage.getItem('zen_mode')).toBe('false')
    expect(isZenEnabled()).toBe(false)
  })

  it('applyZenPreference writes the dataset attribute the CSS blur rule reads', () => {
    applyZenPreference(true)
    expect(doc.documentElement.dataset.zen).toBe('true')
    applyZenPreference(false)
    expect(doc.documentElement.dataset.zen).toBe('false')
  })

  it('applyZenPreference defaults to the stored preference when called with no argument', () => {
    setZenEnabled(true)
    doc.documentElement.dataset.zen = 'false' // simulate a fresh page load before hydration
    applyZenPreference()
    expect(doc.documentElement.dataset.zen).toBe('true')
  })

  it('setZenEnabled applies the preference live, not just persists it', () => {
    setZenEnabled(true)
    expect(doc.documentElement.dataset.zen).toBe('true')
  })

  it('a private window or blocked storage does not throw, and reads back disabled', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(() => isZenEnabled()).not.toThrow()
    expect(isZenEnabled()).toBe(false)
  })

  it('setZenEnabled with blocked storage still applies live for this session', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(() => setZenEnabled(true)).not.toThrow()
    expect(doc.documentElement.dataset.zen).toBe('true')
  })
})
