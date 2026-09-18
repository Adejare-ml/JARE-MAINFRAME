import { describe, it, expect } from 'vitest'
import { buildSparkline } from '../src/lib/sparkline.js'

describe('buildSparkline', () => {
  it('returns nothing for no points', () => {
    expect(buildSparkline([])).toEqual({ path: '', areaPath: '', min: 0, max: 0, coords: [] })
    expect(buildSparkline(null).coords).toEqual([])
  })

  it('places a single point in the vertical middle, horizontally centered', () => {
    const { coords } = buildSparkline([{ date: '2026-09-01', total: 5000 }], { width: 100, height: 40 })
    expect(coords).toHaveLength(1)
    expect(coords[0].x).toBeCloseTo(50)
  })

  it('does not divide by zero on a flat series', () => {
    const { coords } = buildSparkline(
      [
        { date: '2026-09-01', total: 10000 },
        { date: '2026-09-02', total: 10000 },
        { date: '2026-09-03', total: 10000 },
      ],
      { width: 100, height: 40, padding: 0 },
    )
    // A flat series should sit at the vertical middle, not collapse to one edge.
    for (const c of coords) expect(c.y).toBeCloseTo(20)
  })

  it('maps the lowest value to the bottom and the highest to the top', () => {
    const { coords } = buildSparkline(
      [
        { date: '2026-09-01', total: 0 },
        { date: '2026-09-02', total: 100 },
      ],
      { width: 100, height: 40, padding: 0 },
    )
    expect(coords[0].y).toBeCloseTo(40) // lowest value, bottom of the chart
    expect(coords[1].y).toBeCloseTo(0) // highest value, top of the chart
  })

  it('spaces points evenly across the width', () => {
    const { coords } = buildSparkline(
      [
        { date: '2026-09-01', total: 1 },
        { date: '2026-09-02', total: 2 },
        { date: '2026-09-03', total: 3 },
      ],
      { width: 100, height: 40, padding: 0 },
    )
    expect(coords[0].x).toBeCloseTo(0)
    expect(coords[1].x).toBeCloseTo(50)
    expect(coords[2].x).toBeCloseTo(100)
  })

  it('drops points with no date or a non-numeric total rather than crashing', () => {
    const { coords } = buildSparkline([
      { date: '2026-09-01', total: 100 },
      { date: null, total: 200 },
      { date: '2026-09-03', total: 'NaN' },
      { date: '2026-09-04', total: 300 },
    ])
    expect(coords).toHaveLength(2)
  })

  it('builds a path string starting with M and using L for the rest', () => {
    const { path } = buildSparkline([
      { date: '2026-09-01', total: 100 },
      { date: '2026-09-02', total: 200 },
    ])
    expect(path.startsWith('M')).toBe(true)
    expect(path).toContain('L')
  })

  it('closes the area path down to the baseline for fill rendering', () => {
    const { areaPath } = buildSparkline([{ date: '2026-09-01', total: 100 }], { height: 40 })
    expect(areaPath.endsWith('Z')).toBe(true)
    expect(areaPath).toContain('40')
  })
})
