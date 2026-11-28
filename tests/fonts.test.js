import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * The naira sign (U+20A6) is not in Inter's `latin` subset. index.css imports
 * the all-subset files for the figure weights, whose latin-ext face declares
 * a unicode-range: that is what lets the browser fetch latin-ext only when a
 * ₦ is on screen. If @fontsource ever drops the range (its per-subset files,
 * latin-ext-600.css, already carry none), every page would fetch it.
 */
const require = createRequire(import.meta.url)
const NAIRA = 0x20a6

function coversCodepoint(range, cp) {
  return range.split(',').some((part) => {
    const [lo, hi] = part.trim().replace(/^U\+/i, '').split('-')
    const start = parseInt(lo, 16)
    const end = hi ? parseInt(hi, 16) : start
    return cp >= start && cp <= end
  })
}

describe('Inter ships the naira glyph lazily', () => {
  for (const weight of [500, 600, 700]) {
    it(`weight ${weight}: the latin-ext face has a unicode-range covering U+20A6`, () => {
      const css = readFileSync(require.resolve(`@fontsource/inter/${weight}.css`), 'utf8')
      const block = css.split('@font-face').find((b) => b.includes(`inter-latin-ext-${weight}-normal.woff2`))
      expect(block).toBeTruthy()
      const range = block.match(/unicode-range:\s*([^;]+);/)?.[1]
      expect(range).toBeTruthy()
      expect(coversCodepoint(range, NAIRA)).toBe(true)
    })
  }

  it('index.css imports those weights and no 800', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    for (const weight of [500, 600, 700]) expect(css).toContain(`@fontsource/inter/${weight}.css`)
    expect(css).not.toMatch(/inter\/(latin-)?800/)
    expect(css).toContain('@fontsource/ibm-plex-mono/latin-400.css')
  })
})
