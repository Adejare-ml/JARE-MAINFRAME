import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isOledEnabled,
  setOledEnabled,
  applyOledPreference,
  getThemeMode,
  setThemeMode,
  resolveTheme,
  applyThemePreference,
} from '../src/lib/theme.js'

/**
 * theme.js talks to `localStorage` and `document` directly, neither of which
 * exists in Vitest's default (plain Node) environment -- confirmed by
 * `typeof localStorage` / `typeof document` both being 'undefined' under
 * Node 22 here. Every test below stubs just enough of each to exercise the
 * real functions rather than reimplementing them.
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

describe('theme (OLED preference)', () => {
  let doc

  beforeEach(() => {
    doc = { documentElement: { dataset: {} } }
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('document', doc)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('defaults to disabled before anything is stored', () => {
    expect(isOledEnabled()).toBe(false)
  })

  it('round-trips through the setter -- the stored string is exactly what the getter compares against', () => {
    setOledEnabled(true)
    expect(localStorage.getItem('oled_background')).toBe('true')
    expect(isOledEnabled()).toBe(true)

    setOledEnabled(false)
    expect(localStorage.getItem('oled_background')).toBe('false')
    expect(isOledEnabled()).toBe(false)
  })

  it('applyOledPreference writes the dataset attribute the CSS selector reads', () => {
    applyOledPreference(true)
    expect(doc.documentElement.dataset.oled).toBe('true')
    applyOledPreference(false)
    expect(doc.documentElement.dataset.oled).toBe('false')
  })

  it('applyOledPreference defaults to the stored preference when called with no argument', () => {
    setOledEnabled(true)
    doc.documentElement.dataset.oled = 'false' // simulate a fresh page load before hydration
    applyOledPreference()
    expect(doc.documentElement.dataset.oled).toBe('true')
  })

  it('setOledEnabled applies the preference live, not just persists it', () => {
    setOledEnabled(true)
    expect(doc.documentElement.dataset.oled).toBe('true')
  })

  it('a private window or blocked storage does not throw, and reads back disabled', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(() => isOledEnabled()).not.toThrow()
    expect(isOledEnabled()).toBe(false)
  })

  it('setOledEnabled with blocked storage still applies live for this session', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(() => setOledEnabled(true)).not.toThrow()
    expect(doc.documentElement.dataset.oled).toBe('true')
  })
})

describe('theme (dark/light/system mode)', () => {
  let doc

  beforeEach(() => {
    doc = { documentElement: { dataset: {} } }
    vi.stubGlobal('localStorage', memoryStorage())
    vi.stubGlobal('document', doc)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('defaults to system before anything is stored -- not pinned to dark', () => {
    expect(getThemeMode()).toBe('system')
  })

  it('round-trips dark and light through the setter', () => {
    setThemeMode('dark')
    expect(localStorage.getItem('theme_mode')).toBe('dark')
    expect(getThemeMode()).toBe('dark')

    setThemeMode('light')
    expect(localStorage.getItem('theme_mode')).toBe('light')
    expect(getThemeMode()).toBe('light')
  })

  it('treats anything unrecognised in storage as system', () => {
    localStorage.setItem('theme_mode', 'sepia')
    expect(getThemeMode()).toBe('system')
  })

  it('resolveTheme passes dark and light straight through, without touching matchMedia', () => {
    vi.stubGlobal('window', {
      matchMedia: () => {
        throw new Error('should not be called for an explicit mode')
      },
    })
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
  })

  it('resolveTheme asks matchMedia only for system, and reflects the device', () => {
    vi.stubGlobal('window', { matchMedia: (q) => ({ matches: q.includes('light') }) })
    expect(resolveTheme('system')).toBe('light')

    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    expect(resolveTheme('system')).toBe('dark')
  })

  it('resolveTheme falls back to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('window', {})
    expect(resolveTheme('system')).toBe('dark')
  })

  it('applyThemePreference writes the resolved mode to the dataset attribute the CSS reads', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
    applyThemePreference('light')
    expect(doc.documentElement.dataset.theme).toBe('light')
    applyThemePreference('system')
    expect(doc.documentElement.dataset.theme).toBe('dark')
  })

  it('setThemeMode applies live, not just persists', () => {
    setThemeMode('light')
    expect(doc.documentElement.dataset.theme).toBe('light')
  })

  it('a private window or blocked storage does not throw, and reads back system', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(() => getThemeMode()).not.toThrow()
    expect(getThemeMode()).toBe('system')
    expect(() => setThemeMode('dark')).not.toThrow()
    expect(doc.documentElement.dataset.theme).toBe('dark')
  })
})
