/**
 * Turn a series of {date, total} points into SVG coordinates.
 *
 * Pure on purpose, same reason planning.js's arithmetic is: the scaling math
 * (where a value lands vertically, how points space out horizontally) is
 * exactly the kind of off-by-one/division-by-zero code that is cheap to get
 * wrong and cheap to test, and a component cannot be unit tested the way a
 * function can in this project (no DOM test harness exists here).
 */

/**
 * @param {Array<{date: string, total: number}>} points - ascending by date
 * @param {{width?: number, height?: number, padding?: number}} [opts]
 * @returns {{
 *   path: string,
 *   areaPath: string,
 *   min: number,
 *   max: number,
 *   coords: Array<{x: number, y: number, date: string, total: number}>,
 * }}
 */
export function buildSparkline(points, { width = 320, height = 80, padding = 4 } = {}) {
  const clean = (points || []).filter((p) => p && p.date && Number.isFinite(Number(p.total)))

  if (clean.length === 0) {
    return { path: '', areaPath: '', min: 0, max: 0, coords: [] }
  }

  const values = clean.map((p) => Number(p.total))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min

  const innerWidth = width - padding * 2
  const innerHeight = height - padding * 2
  const step = clean.length > 1 ? innerWidth / (clean.length - 1) : 0

  const coords = clean.map((p, i) => {
    const value = Number(p.total)
    const x = padding + (clean.length > 1 ? i * step : innerWidth / 2)
    // A flat series (every day the same balance, range === 0) sits at the
    // vertical middle. Dividing by `range || 1` instead would silently put it
    // at the bottom edge -- every point reads as 0% of a zero-width range,
    // which looks like "net worth is at its lowest" for a balance that never
    // moved at all.
    const y =
      range === 0 ? padding + innerHeight / 2 : padding + innerHeight - ((value - min) / range) * innerHeight
    return { x, y, date: p.date, total: value }
  })

  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ')

  const areaPath =
    coords.length > 0
      ? `${path} L${coords[coords.length - 1].x.toFixed(2)},${height} L${coords[0].x.toFixed(2)},${height} Z`
      : ''

  return { path, areaPath, min, max, coords }
}
