import { describe, it, expect } from 'vitest'
import { GLYPH_NAMES } from '../src/components/ui/Icon.jsx'
import { ICON_NAMES } from '../src/lib/constants.js'

describe('Icon glyph names', () => {
  it('match the dependency-free list in constants.js exactly', () => {
    expect([...GLYPH_NAMES].sort()).toEqual([...ICON_NAMES].sort())
  })

  it('fit the 8-character check on goals.icon', () => {
    for (const name of GLYPH_NAMES) expect(name.length).toBeLessThanOrEqual(8)
  })
})
