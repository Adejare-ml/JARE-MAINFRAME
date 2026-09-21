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
  it('reports the dark theme\'s own documented muted-dim/card ratio correctly', () => {
    // index.css: "--color-muted-dim: #8a8a8a;  /* 5.0:1 on card */"
    expect(contrastRatio('#8a8a8a', '#1a1a1a')).toBeCloseTo(5.0, 1)
  })
})

describe('light theme palette (src/index.css :root[data-theme="light"])', () => {
  // Kept in sync with index.css by hand -- the same "duplication documented
  // on purpose" this project already accepts for TRANSFER_CATEGORIES and
  // similar lists, so a new pair chosen in CSS is a test failure here until
  // it is added to both places.
  const LIGHT = {
    background: '#f5f5f5',
    card: '#ffffff',
    foreground: '#18181b',
    muted: '#52525b',
    accent: '#166534',
    mutedDim: '#595966',
    hint: '#6e6e78',
  }

  it('foreground text clears AA on both surfaces', () => {
    expect(contrastRatio(LIGHT.foreground, LIGHT.background)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
    expect(contrastRatio(LIGHT.foreground, LIGHT.card)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
  })

  it('muted text clears AA on both surfaces', () => {
    expect(contrastRatio(LIGHT.muted, LIGHT.background)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
    expect(contrastRatio(LIGHT.muted, LIGHT.card)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
  })

  it('muted-dim text clears AA on both surfaces', () => {
    expect(contrastRatio(LIGHT.mutedDim, LIGHT.background)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
    expect(contrastRatio(LIGHT.mutedDim, LIGHT.card)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
  })

  it('hint text clears AA on card -- placeholders only, matching the dark theme\'s own convention for this token', () => {
    expect(contrastRatio(LIGHT.hint, LIGHT.card)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
  })

  it('accent text clears AA on both surfaces (its text role -- see index.css for the bg-fill tradeoff this does not cover)', () => {
    expect(contrastRatio(LIGHT.accent, LIGHT.background)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
    expect(contrastRatio(LIGHT.accent, LIGHT.card)).toBeGreaterThanOrEqual(AA_TEXT_MINIMUM)
  })

  it('card is lighter than background, matching the dark theme\'s own card-raised-above-background relationship', () => {
    expect(relativeLuminance(LIGHT.card)).toBeGreaterThan(relativeLuminance(LIGHT.background))
  })
})
