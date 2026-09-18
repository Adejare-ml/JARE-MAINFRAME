/**
 * A short buzz on a key confirmation, where the device actually supports it.
 *
 * `navigator.vibrate` is desktop-absent and iOS-Safari-absent -- calling it
 * where it does not exist is a silent no-op in every browser that matters
 * here, so the guard is defensive rather than load-bearing, and a throw
 * inside (some browsers refuse without a recent user gesture) must never
 * take down the confirmation it was decorating.
 *
 * @param {number|number[]} [pattern] - ms, or an on/off/on/... pattern
 */
export function confirmBuzz(pattern = 15) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // Decoration, not a dependency.
  }
}
