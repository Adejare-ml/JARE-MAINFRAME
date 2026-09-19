import { describe, it, expect } from 'vitest'
import {
  resolveSwipe,
  DEFAULT_MIN_DISTANCE,
  DEFAULT_MAX_OFF_AXIS_RATIO,
  DEFAULT_MAX_DURATION_MS,
} from '../src/lib/swipeGesture.js'

const point = (x, y, t) => ({ x, y, t })

describe('resolveSwipe', () => {
  it('resolves a clear leftward swipe', () => {
    expect(resolveSwipe(point(200, 100, 0), point(100, 102, 150))).toBe('left')
  })

  it('resolves a clear rightward swipe', () => {
    expect(resolveSwipe(point(100, 100, 0), point(200, 98, 150))).toBe('right')
  })

  it('rejects a mostly-vertical movement -- a scroll, not a swipe', () => {
    // Same horizontal distance as the clear cases above, but with vertical
    // drift past the tolerance, so this must not fight the page's own scroll.
    expect(resolveSwipe(point(100, 100, 0), point(200, 250, 150))).toBe(null)
  })

  it('rejects a movement shorter than the tap-to-expand gesture already owns', () => {
    expect(resolveSwipe(point(100, 100, 0), point(130, 100, 100))).toBe(null)
  })

  it('rejects a slow drag that exceeds the duration budget', () => {
    expect(resolveSwipe(point(200, 100, 0), point(100, 100, 900))).toBe(null)
  })

  it('resolves exactly at the minimum distance threshold', () => {
    expect(resolveSwipe(point(200, 100, 0), point(200 - DEFAULT_MIN_DISTANCE, 100, 150))).toBe('left')
  })

  it('rejects one pixel short of the minimum distance threshold', () => {
    expect(resolveSwipe(point(200, 100, 0), point(200 - DEFAULT_MIN_DISTANCE + 1, 100, 150))).toBe(null)
  })

  it('resolves exactly at the duration budget', () => {
    expect(resolveSwipe(point(200, 100, 0), point(100, 100, DEFAULT_MAX_DURATION_MS))).toBe('left')
  })

  it('rejects one millisecond past the duration budget', () => {
    expect(resolveSwipe(point(200, 100, 0), point(100, 100, DEFAULT_MAX_DURATION_MS + 1))).toBe(null)
  })

  it('resolves exactly at the off-axis ratio boundary', () => {
    const dx = 100
    const dy = dx * DEFAULT_MAX_OFF_AXIS_RATIO
    expect(resolveSwipe(point(200, 100, 0), point(200 - dx, 100 + dy, 150))).toBe('left')
  })

  it('rejects a hair past the off-axis ratio boundary', () => {
    const dx = 100
    const dy = dx * DEFAULT_MAX_OFF_AXIS_RATIO + 1
    expect(resolveSwipe(point(200, 100, 0), point(200 - dx, 100 + dy, 150))).toBe(null)
  })

  it('never throws on missing or malformed points', () => {
    expect(resolveSwipe(null, point(0, 0, 0))).toBe(null)
    expect(resolveSwipe(point(0, 0, 0), null)).toBe(null)
    expect(resolveSwipe(undefined, undefined)).toBe(null)
    expect(resolveSwipe({ x: 'a', y: 0, t: 0 }, point(100, 0, 100))).toBe(null)
  })
})
