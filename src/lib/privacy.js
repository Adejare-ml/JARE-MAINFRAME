/**
 * Zen mode: one tap to stop the numbers on screen being readable over your
 * shoulder. A per-device preference, same shape as lib/theme.js's OLED
 * toggle and for the same reason -- localStorage, applied before first
 * paint via main.jsx, no database round trip and no flash of unmasked
 * figures while one resolves.
 *
 * Masking is a CSS rule (`[data-zen="true"] .money { filter: blur(...) }`,
 * see index.css) rather than a component that swaps in placeholder text:
 * every figure already renders through formatNaira() at dozens of call
 * sites across the app, and a CSS-only mechanism needs only a class name
 * added at each one, not a new component threaded through all of them.
 */

const STORAGE_KEY = 'zen_mode'

export function isZenEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function applyZenPreference(enabled = isZenEnabled()) {
  document.documentElement.dataset.zen = enabled ? 'true' : 'false'
}

export function setZenEnabled(enabled) {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // Best-effort persistence; still applied live for this session.
  }
  applyZenPreference(enabled)
}
