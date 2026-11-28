import { describe, it, expect } from 'vitest'
import { hexToRgb, relativeLuminance, contrastRatio, AA_TEXT_MINIMUM } from '../src/lib/contrast.js'

describe('hexToRgb', () => {
  it('parses a full six-digit hex', () => {
    expect(hexToRgb('#ff8800')).toEqual({ r: 255, g: 136, b: 0 })
  })

  it('expands a three-digit shorthand', () => {
    expect(hexToRgb('#f80')).toEqual({ r: 255, g: 136, b: 0 })
  })

  it('works without the leading #', () => {
    expect(hexToRgb('ffffff')).toEqual({ r: 255, g: 255, b: 255 })
  })
})

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('contrastRatio', () => {
  it('matches the textbook black/white ratio of 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1)
  })

  it('is 1:1 for identical colors', () => {
    expect(contrastRatio('#22c55e', '#22c55e')).toBeCloseTo(1, 5)
  })

  it('does not care about argument order', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#000000'), 10)
  })

  // A reference pair independently known to sit just under the AA floor --
  // this project's own pre-fix red-500-on-card measured 4.6:1 (Stage O), so
  // a very similar gray pair here pins the formula against a real prior
  // measurement rather than only textbook endpoints.
  it('reports a previously measured pair correctly', () => {
    // The old dark theme's muted-dim on card, hand-measured at 5.0:1.
    expect(contrastRatio('#8a8a8a', '#1a1a1a')).toBeCloseTo(5.0, 1)
  })
})

/*
 * The three palettes, kept in sync with src/index.css by hand: a value
 * changed in CSS is a failure here until it changes in both places. Every
 * text token must clear AA (4.5:1) and both border tokens the 3:1 non-text
 * floor, on each of the three surfaces a token can sit on.
 */
const DARK = {
  background: '#0b0c0d',
  card: '#131517',
  surface2: '#1c1f22',
  foreground: '#ecece8',
  muted: '#a6aab0',
  mutedDim: '#93979d',
  hint: '#8b8f95',
  border: '#696e74',
  borderStrong: '#8b8f95',
  accent: '#22c55e',
  onAccent: '#05140b',
  warn: '#f0a93b',
  danger: '#f87171',
}

const LIGHT = {
  background: '#f1f2f0',
  card: '#ffffff',
  surface2: '#e6e8e5',
  foreground: '#15171a',
  muted: '#474c53',
  mutedDim: '#51565d',
  hint: '#595e65',
  border: '#7f848b',
  borderStrong: '#595e65',
  accent: '#166534',
  onAccent: '#ffffff',
  warn: '#8a4700',
  danger: '#b42318',
}

// OLED moves the page background only.
const OLED = { ...DARK, background: '#000000' }

const TEXT_TOKENS = ['foreground', 'muted', 'mutedDim', 'hint', 'accent', 'warn', 'danger']
const BORDER_TOKENS = ['border', 'borderStrong']
const SURFACES = ['background', 'card', 'surface2']
const NON_TEXT_MINIMUM = 3

for (const [name, palette] of Object.entries({ dark: DARK, light: LIGHT, oled: OLED })) {
  describe(`${name} palette (src/index.css)`, () => {
    for (const token of TEXT_TOKENS) {
      for (const surface of SURFACES) {
        it(`${token} text clears AA on ${surface}`, () => {
          expect(contrastRatio(palette[token], palette[surface])).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
        })
      }
    }

    for (const token of BORDER_TOKENS) {
      for (const surface of SURFACES) {
        it(`${token} clears the 3:1 non-text floor on ${surface}`, () => {
          expect(contrastRatio(palette[token], palette[surface])).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM)
        })
      }
    }

    for (const fill of ['accent', 'warn', 'danger']) {
      it(`on-accent text clears AA on a ${fill} fill`, () => {
        expect(contrastRatio(palette.onAccent, palette[fill])).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
      })
    }

    it('elevation runs background, card, surface-2 by surface rather than shadow', () => {
      const l = (k) => relativeLuminance(palette[k])
      if (name === 'light') {
        // Light: the card is the brightest; surface-2 is a pressed grey.
        expect(l('card')).toBeGreaterThan(l('background'))
        expect(l('surface2')).toBeLessThan(l('card'))
      } else {
        expect(l('card')).toBeGreaterThan(l('background'))
        expect(l('surface2')).toBeGreaterThan(l('card'))
      }
    })
  })
}

describe('the palette in this test matches src/index.css', () => {
  it('every dark token above is declared in the @theme block', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    const kebab = (k) => k.replace(/[A-Z0-9]/g, (c) => (/[0-9]/.test(c) ? `-${c}` : `-${c.toLowerCase()}`))
    for (const [token, hex] of Object.entries(DARK)) {
      expect(css).toContain(`--color-${kebab(token)}: ${hex};`)
    }
    for (const [token, hex] of Object.entries(LIGHT)) {
      expect(css).toContain(`--color-${kebab(token)}: ${hex};`)
    }
  })
})
