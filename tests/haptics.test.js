import { describe, it, expect, afterEach, vi } from 'vitest'
import { confirmBuzz } from '../src/lib/haptics.js'

describe('confirmBuzz', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('calls navigator.vibrate with the default pattern when none is given', () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    confirmBuzz()
    expect(vibrate).toHaveBeenCalledWith(15)
  })

  it('passes a custom pattern through unchanged', () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    confirmBuzz([10, 20, 10])
    expect(vibrate).toHaveBeenCalledWith([10, 20, 10])
  })

  it('does not throw when navigator.vibrate does not exist -- desktop and iOS Safari', () => {
    vi.stubGlobal('navigator', {})
    expect(() => confirmBuzz()).not.toThrow()
  })

  it('does not throw when navigator itself is unavailable', () => {
    vi.stubGlobal('navigator', undefined)
    expect(() => confirmBuzz()).not.toThrow()
  })

  it('swallows a throw from navigator.vibrate -- decoration, not a dependency', () => {
    vi.stubGlobal('navigator', {
      vibrate: () => {
        throw new Error('vibrate requires a recent user gesture')
      },
    })
    expect(() => confirmBuzz()).not.toThrow()
  })
})
