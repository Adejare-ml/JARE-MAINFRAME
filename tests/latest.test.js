import { describe, it, expect } from 'vitest'
import { createSequence } from '../src/lib/latest.js'

describe('createSequence', () => {
  it('accepts only the newest token', () => {
    const seq = createSequence()
    const first = seq.next()
    expect(seq.isCurrent(first)).toBe(true)
    const second = seq.next()
    expect(seq.isCurrent(first)).toBe(false)
    expect(seq.isCurrent(second)).toBe(true)
    expect(seq.current).toBe(second)
  })

  it('rejects a token that was never issued', () => {
    const seq = createSequence()
    expect(seq.isCurrent(0)).toBe(true) // nothing started yet
    seq.next()
    expect(seq.isCurrent(0)).toBe(false)
    expect(seq.isCurrent(99)).toBe(false)
  })
})
