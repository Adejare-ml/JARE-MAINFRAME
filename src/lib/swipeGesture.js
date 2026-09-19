/**
 * Was this pointer movement a deliberate horizontal swipe, or something else
 * that happens to have crossed some pixels -- a scroll, a slow drag, a tap
 * with a shaky hand?
 *
 * Pure geometry, no DOM: given where a pointer went down and where it came
 * up, decide `'left'`, `'right'`, or `null` for "not a swipe, leave it
 * alone." `null` is the important half of this function. Transactions.jsx
 * already has two gestures on a row -- tap to expand, long-press to
 * bulk-select -- and a swipe that fires too eagerly would fight both of
 * them. Rejecting anything too vertical (a page scroll), too short (a tap),
 * or too slow (a drag that paused, not a flick) is what keeps this gesture
 * in its own lane.
 */

/** Shortest horizontal distance that counts as a swipe rather than a tap. */
export const DEFAULT_MIN_DISTANCE = 60

/** How much vertical drift is tolerated before a movement reads as a scroll
 *  instead of a horizontal swipe -- a fraction of the horizontal distance. */
export const DEFAULT_MAX_OFF_AXIS_RATIO = 0.5

/** Longest a pointer-down-to-up gesture may take and still count as a swipe
 *  rather than a slow drag or an accidental long hold. */
export const DEFAULT_MAX_DURATION_MS = 600

/**
 * @typedef {{x: number, y: number, t: number}} Point - clientX/clientY and a timestamp (ms)
 */

/**
 * @param {Point} start - where the pointer went down
 * @param {Point} end - where the pointer came up
 * @param {{minDistance?: number, maxOffAxisRatio?: number, maxDurationMs?: number}} [options]
 * @returns {'left'|'right'|null}
 */
export function resolveSwipe(
  start,
  end,
  {
    minDistance = DEFAULT_MIN_DISTANCE,
    maxOffAxisRatio = DEFAULT_MAX_OFF_AXIS_RATIO,
    maxDurationMs = DEFAULT_MAX_DURATION_MS,
  } = {},
) {
  if (!start || !end) return null

  const dx = Number(end.x) - Number(start.x)
  const dy = Number(end.y) - Number(start.y)
  const duration = Number(end.t) - Number(start.t)

  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(duration)) return null

  // Too slow: a pause mid-drag, not a flick. Checked first so a long, lazy
  // drag across the full distance still reads as "not a swipe" rather than
  // sneaking through on distance alone.
  if (duration > maxDurationMs) return null

  // Too vertical: this is a page scroll started on a row, not a horizontal
  // gesture. Guards against dx === 0 dividing by nothing.
  if (Math.abs(dy) > Math.abs(dx) * maxOffAxisRatio) return null

  // Too short: a tap, or a twitch of the thumb -- exactly what tap-to-expand
  // already owns and must not be preempted from.
  if (Math.abs(dx) < minDistance) return null

  return dx < 0 ? 'left' : 'right'
}
