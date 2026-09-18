/**
 * True-black OLED background -- a purely per-device visual preference, kept
 * in localStorage rather than user_settings so it applies before first
 * paint with no database round trip to wait on, and no flash of the default
 * background while one resolves.
 */

const STORAGE_KEY = 'oled_background'

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
