import { describe, it, expect } from 'vitest'
import {
  luma,
  assessExposure,
  describeCast,
  planCorrection,
  gammaToReach,
  buildLut,
  applyLut,
  describeQuality,
  fitWithin,
  base64Bytes,
  stripDataUrl,
  isSupportedImage,
  MIN_GAMMA,
  MAX_GAMMA,
  CAST_THRESHOLD,
  MAX_EDGE,
  MAX_UPLOAD_CHARS,
  ENCODE_LADDER,
} from '../src/lib/imagePrep.js'

/** An image whose every pixel is the given colour. */
function flat(width, height, [r, g, b], a = 255) {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = a
  }
  return out
}

/** A horizontal grey ramp from `from` to `to`, so the histogram has a known span. */
function ramp(width, height, from, to) {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round(from + ((to - from) * x) / Math.max(1, width - 1))
      const o = (y * width + x) * 4
      out[o] = out[o + 1] = out[o + 2] = v
      out[o + 3] = 255
    }
  }
  return out
}

describe('luma', () => {
  it('weights green most and blue least', () => {
    expect(luma(255, 0, 0)).toBeCloseTo(76.2, 0)
    expect(luma(0, 255, 0)).toBeCloseTo(149.7, 0)
    expect(luma(0, 0, 255)).toBeCloseTo(29.1, 0)
    expect(luma(255, 255, 255)).toBeCloseTo(255, 5)
  })
})

describe('assessExposure', () => {
  it('reads a flat grey correctly', () => {
    const s = assessExposure(flat(10, 10, [120, 120, 120]), 10, 10)
    expect(s.samples).toBe(100)
    expect(s.mean).toBeCloseTo(120, 5)
    expect(s.median).toBe(120)
    expect(s.p1).toBe(120)
    expect(s.p99).toBe(120)
    expect(s.darkFraction).toBe(0)
    expect(s.brightFraction).toBe(0)
    expect(s.cast.kind).toBe('none')
  })

  it('finds the span of a ramp and the clipped fractions', () => {
    const s = assessExposure(ramp(256, 2, 0, 255), 256, 2)
    expect(s.p1).toBeLessThanOrEqual(3)
    expect(s.p99).toBeGreaterThanOrEqual(252)
    expect(s.median).toBeGreaterThan(120)
    expect(s.median).toBeLessThan(135)
    // 9 of 256 columns are <= 8 and 9 are >= 247.
    expect(s.darkFraction).toBeCloseTo(9 / 256, 2)
    expect(s.brightFraction).toBeCloseTo(9 / 256, 2)
  })

  it('samples with a stride on a large image and still lands on the same answer', () => {
    const big = ramp(400, 400, 20, 200)
    const dense = assessExposure(big, 400, 400, { step: 1 })
    const sparse = assessExposure(big, 400, 400)
    expect(sparse.samples).toBeLessThan(dense.samples)
    expect(Math.abs(sparse.mean - dense.mean)).toBeLessThan(2)
    expect(Math.abs(sparse.median - dense.median)).toBeLessThan(3)
  })

  it('names a warm cast from the mid-tones only', () => {
    // Tungsten: red leads, blue trails.
    const s = assessExposure(flat(8, 8, [180, 140, 90]), 8, 8)
    expect(s.cast.kind).toBe('warm')
    expect(s.cast.strength).toBeGreaterThan(CAST_THRESHOLD)
  })

  it('survives an empty array', () => {
    const s = assessExposure(new Uint8ClampedArray(0), 0, 0)
    expect(s.samples).toBe(0)
    expect(planCorrection(s).apply).toBe(false)
  })
})

describe('describeCast', () => {
  it('is none for grey light and for black', () => {
    expect(describeCast({ r: 100, g: 100, b: 100 }).kind).toBe('none')
    expect(describeCast({ r: 0, g: 0, b: 0 }).kind).toBe('none')
  })
  it('tells warm from cool from green from magenta', () => {
    expect(describeCast({ r: 160, g: 130, b: 100 }).kind).toBe('warm')
    expect(describeCast({ r: 100, g: 130, b: 160 }).kind).toBe('cool')
    expect(describeCast({ r: 100, g: 160, b: 100 }).kind).toBe('green')
    expect(describeCast({ r: 160, g: 100, b: 160 }).kind).toBe('magenta')
  })
  it('ignores a cast under the threshold', () => {
    expect(describeCast({ r: 110, g: 100, b: 100 }).kind).toBe('none')
  })
})

describe('planCorrection', () => {
  it('leaves a well-exposed photo alone', () => {
    const plan = planCorrection(assessExposure(ramp(256, 2, 10, 245), 256, 2))
    expect(plan.label).toBe('good')
    expect(plan.apply).toBe(false)
    expect(plan.gamma).toBe(1)
  })

  it('lifts a dark photo with a gamma under 1, no lower than the noise cap', () => {
    const plan = planCorrection(assessExposure(ramp(256, 2, 10, 90), 256, 2))
    expect(plan.label).toBe('dark')
    expect(plan.apply).toBe(true)
    expect(plan.gamma).toBeLessThan(1)
    expect(plan.gamma).toBeGreaterThanOrEqual(MIN_GAMMA)
  })

  it('flags a nearly black photo with a little light as very dark and uses the cap', () => {
    // 95% at luma 10, 5% at 180: mean 18.5, but something in the frame is lit.
    const img = flat(100, 1, [10, 10, 10])
    for (let x = 95; x < 100; x++) img[x * 4] = img[x * 4 + 1] = img[x * 4 + 2] = 180
    const stats = assessExposure(img, 100, 1)
    const plan = planCorrection(stats)
    expect(plan.label).toBe('very-dark')
    expect(plan.gamma).toBe(MIN_GAMMA)
    expect(describeQuality(stats, plan).unreliable).toBe(true)
  })

  it('refuses to correct a photo with nothing lit in it and says what to do', () => {
    const stats = assessExposure(flat(10, 10, [12, 12, 12]), 10, 10)
    const plan = planCorrection(stats)
    expect(plan.label).toBe('unusable')
    expect(plan.apply).toBe(false)
    const q = describeQuality(stats, plan)
    expect(q.unusable).toBe(true)
    expect(q.unreliable).toBe(true)
    expect(q.note).toMatch(/turn on a light/)
  })

  it('tones a washed-out photo down with a gamma over 1 and keeps the white point', () => {
    const plan = planCorrection(assessExposure(ramp(256, 2, 170, 255), 256, 2))
    expect(plan.label).toBe('bright')
    expect(plan.gamma).toBeGreaterThan(1)
    expect(plan.gamma).toBeLessThanOrEqual(MAX_GAMMA)
    expect(plan.white).toBe(255)
  })

  it('stretches a flat mid-grey photo without a gamma change', () => {
    const plan = planCorrection(assessExposure(ramp(256, 2, 100, 150), 256, 2))
    expect(plan.label).toBe('low-contrast')
    expect(plan.gamma).toBe(1)
    expect(plan.black).toBeLessThanOrEqual(40)
    expect(plan.white).toBeGreaterThanOrEqual(200)
  })

  it('never moves the black point past 40 or the white point under 200', () => {
    const plan = planCorrection(assessExposure(ramp(256, 2, 60, 120), 256, 2))
    expect(plan.black).toBeLessThanOrEqual(40)
    expect(plan.white).toBeGreaterThanOrEqual(200)
  })
})

describe('gammaToReach', () => {
  it('maps a mid-tone onto the target', () => {
    const g = gammaToReach(0.2, 0.45)
    expect(Math.pow(0.2, g)).toBeCloseTo(0.45, 6)
  })
  it('is 1 when the inputs make no sense', () => {
    expect(gammaToReach(0, 0.45)).toBe(1)
    expect(gammaToReach(1, 0.45)).toBe(1)
    expect(gammaToReach(0.3, 0)).toBe(1)
    expect(gammaToReach(NaN, 0.5)).toBe(1)
  })
})

describe('buildLut / applyLut', () => {
  it('is identity by default', () => {
    const lut = buildLut()
    for (let v = 0; v < 256; v++) expect(lut[v]).toBe(v)
  })

  it('is monotonic and pinned to the levels', () => {
    const lut = buildLut({ black: 20, white: 220, gamma: 0.7 })
    expect(lut[0]).toBe(0)
    expect(lut[20]).toBe(0)
    expect(lut[220]).toBe(255)
    expect(lut[255]).toBe(255)
    for (let v = 1; v < 256; v++) expect(lut[v]).toBeGreaterThanOrEqual(lut[v - 1])
  })

  it('brightens mid-tones with gamma under 1 and darkens them with gamma over 1', () => {
    expect(buildLut({ gamma: 0.6 })[64]).toBeGreaterThan(64)
    expect(buildLut({ gamma: 1.6 })[192]).toBeLessThan(192)
  })

  it('tolerates a degenerate white point and a bad gamma', () => {
    const lut = buildLut({ black: 250, white: 10, gamma: -2 })
    expect(lut[255]).toBe(255)
    expect(lut[0]).toBe(0)
  })

  it('applies to R, G and B and leaves alpha alone, preserving hue order', () => {
    const px = flat(2, 1, [40, 80, 120], 200)
    applyLut(px, buildLut({ gamma: 0.5 }))
    expect(px[3]).toBe(200)
    expect(px[0]).toBeGreaterThan(40)
    // Same curve on every channel: the channel that led still leads.
    expect(px[0]).toBeLessThan(px[1])
    expect(px[1]).toBeLessThan(px[2])
  })

  it('lifts a dark plate into a readable range end to end', () => {
    const img = ramp(256, 4, 5, 70)
    const stats = assessExposure(img, 256, 4)
    const plan = planCorrection(stats)
    applyLut(img, buildLut(plan))
    const after = assessExposure(img, 256, 4)
    expect(after.median).toBeGreaterThan(stats.median * 1.5)
    expect(after.median).toBeGreaterThan(60)
  })
})

describe('describeQuality', () => {
  it('says what was done and about the light', () => {
    const stats = assessExposure(flat(8, 8, [60, 45, 30]), 8, 8)
    const plan = planCorrection(stats)
    const q = describeQuality(stats, plan)
    expect(q.lighting).toBe('dark')
    expect(q.corrected).toBe(true)
    expect(q.cast).toBe('warm')
    expect(q.note).toMatch(/Dark photo, brightened/)
    expect(q.note).toMatch(/warm/)
  })
  it('is quiet about a good photo', () => {
    const stats = assessExposure(ramp(256, 2, 10, 245), 256, 2)
    const q = describeQuality(stats, planCorrection(stats))
    expect(q.corrected).toBe(false)
    expect(q.note).toBe('Light looks fine')
  })
})

describe('the upload budget', () => {
  it('keeps the ladder monotonic and under the inline-image ceiling', () => {
    expect(ENCODE_LADDER[0][0]).toBe(MAX_EDGE)
    for (let i = 1; i < ENCODE_LADDER.length; i++) {
      const [edge, q] = ENCODE_LADDER[i]
      const [prevEdge, prevQ] = ENCODE_LADDER[i - 1]
      expect(edge <= prevEdge && q <= prevQ).toBe(true)
      expect(edge < prevEdge || q < prevQ).toBe(true)
    }
    // ~130 KB decoded: inside what NVIDIA NIM accepts inline (about 180 KB).
    expect(base64Bytes('A'.repeat(MAX_UPLOAD_CHARS))).toBeLessThan(180 * 1024)
  })
})

describe('fitWithin', () => {
  it('caps the long side and keeps the ratio', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 896, height: 672, scale: 0.224 })
    expect(fitWithin(3000, 4000).height).toBe(896)
  })
  it('never upscales', () => {
    expect(fitWithin(640, 480)).toEqual({ width: 640, height: 480, scale: 1 })
  })
  it('survives nonsense sizes', () => {
    expect(fitWithin(0, 0).width).toBe(1)
  })
})

describe('base64 helpers', () => {
  it('counts decoded bytes with and without padding', () => {
    expect(base64Bytes('aGVsbG8=')).toBe(5)
    expect(base64Bytes('aGk=')).toBe(2)
    expect(base64Bytes('aGV5')).toBe(3)
    expect(base64Bytes('')).toBe(0)
    expect(base64Bytes(null)).toBe(0)
  })
  it('strips a data URL prefix and leaves bare base64 alone', () => {
    expect(stripDataUrl('data:image/jpeg;base64,AAAA')).toBe('AAAA')
    expect(stripDataUrl('AAAA')).toBe('AAAA')
    expect(stripDataUrl(undefined)).toBe('')
  })
})

describe('isSupportedImage', () => {
  it('accepts image mime types and image extensions when the type is blank', () => {
    expect(isSupportedImage({ type: 'image/jpeg', name: 'a.jpg' })).toBe(true)
    expect(isSupportedImage({ type: '', name: 'lunch.PNG' })).toBe(true)
    expect(isSupportedImage({ type: 'application/pdf', name: 'menu.pdf' })).toBe(false)
    expect(isSupportedImage(null)).toBe(false)
  })
})
