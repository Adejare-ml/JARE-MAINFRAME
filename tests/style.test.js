import { describe, it, expect } from 'vitest'
import { checkFiles, emojiHits, colourHits } from '../scripts/check-style.mjs'

/**
 * The design system's mechanical rules (scripts/check-style.mjs): no emoji,
 * no raw colour. Strict for the files the design system itself owns; the
 * Phase 3 integrator widens STRICT_PATHS to all of src/.
 */
const STRICT_PATHS = [
  'src/index.css',
  'src/components/ui',
  'src/components/layout',
  'src/lib/nav.js',
  'src/lib/constants.js',
  'src/lib/categories.js',
  'src/lib/toast.js',
  'src/lib/formatters.js',
  'src/lib/systemStatus.js',
  'src/lib/useSystemStatus.js',
  'index.html',
  'public/sw.js',
  'public/manifest.webmanifest',
]

describe('check-style detector', () => {
  it('flags emoji, pictograph stand-ins and the presentation selector', () => {
    expect(emojiHits('Logged \u{1F4B0}')).toEqual(['U+1F4B0'])
    expect(emojiHits('Done ✓')).toEqual(['U+2713'])
    expect(emojiHits('gear ⚙️')).toEqual(['U+2699', 'U+FE0F'])
  })

  it('lets plain text, the naira sign, minus and (c)/(R)/TM through', () => {
    expect(emojiHits('₦2,500 − fees · 09:41 © ® ™')).toEqual([])
    // An escape in source is text, not an emoji.
    expect(emojiHits("'\\u{1F6D2}': 'cart'")).toEqual([])
  })

  it('flags raw colour classes and hex literals, not tokens', () => {
    expect(colourHits('className="text-white bg-black/50 hover:border-white/10"')).toEqual([
      'text-white',
      'bg-black',
      'hover:border-white',
    ])
    expect(colourHits('bg-[#0f0f0f]')).toEqual(['-[#0f0f0f]'])
    expect(colourHits('text-foreground bg-surface-2 border-border')).toEqual([])
  })
})

describe('design-system files are clean', () => {
  it('have no emoji and no raw colour', () => {
    const problems = checkFiles(STRICT_PATHS).map((p) => `${p.file}:${p.line} ${p.kind} ${p.detail}`)
    expect(problems).toEqual([])
  })
})
