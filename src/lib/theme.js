/**
 * True-black OLED background, and light/dark/system mode -- both purely
 * per-device visual preferences, kept in localStorage rather than
 * user_settings so they apply before first paint with no database round
 * trip to wait on, and no flash of the default while one resolves.
 */

const STORAGE_KEY = 'oled_background'
const THEME_MODE_KEY = 'theme_mode'

export function isOledEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    // A private window or blocked storage just means the preference does
    // not persist across reloads, not that reading it should throw.
    return false
  }
}

/** Applies the given (or currently stored) preference to the document. */
export function applyOledPreference(enabled = isOledEnabled()) {
  document.documentElement.dataset.oled = enabled ? 'true' : 'false'
}

export function setOledEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // Best-effort persistence; still apply it live for this session.
  }
  applyOledPreference(enabled)
}

/**
 * The stored mode -- 'dark', 'light', or 'system'. Defaults to 'system'
 * rather than 'dark': a fresh install with nothing stored should follow the
 * device, not silently pin everyone to the mode this app shipped with
 * first.
 *
 * @returns {'dark'|'light'|'system'}
 */
export function getThemeMode() {
  try {
    const stored = localStorage.getItem(THEME_MODE_KEY)
    return stored === 'dark' || stored === 'light' ? stored : 'system'
  } catch {
    return 'system'
  }
}

/**
 * What 'system' actually resolves to right now. 'dark'/'light' pass
 * through unchanged -- only 'system' needs the device asked.
 *
 * Falls back to 'dark' when `matchMedia` itself is unavailable (this
 * module loads under plain Node in CI, and some embedded webviews omit it)
 * rather than throwing, matching this app's dark-first default.
 *
 * @param {'dark'|'light'|'system'} [mode]
 * @returns {'dark'|'light'}
 */
export function resolveTheme(mode = getThemeMode()) {
  if (mode === 'dark' || mode === 'light') return mode
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/** Applies the given (or currently stored) mode to the document, resolving 'system' first. */
export function applyThemePreference(mode = getThemeMode()) {
  document.documentElement.dataset.theme = resolveTheme(mode)
}

export function setThemeMode(mode) {
  try {
    localStorage.setItem(THEME_MODE_KEY, mode)
  } catch {
    // Best-effort persistence; still apply it live for this session.
  }
  applyThemePreference(mode)
}
