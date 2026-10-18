/**
 * Getting a meal photo ready for the model: smaller, and lit well enough to
 * read.
 *
 * A phone photo of dinner is four to twelve megapixels taken wherever dinner
 * is: a kitchen with one bulb, a canteen under fluorescent tubes, a desk lit
 * by a laptop screen, a balcony at noon. The model is asked one question of
 * it -- what food is this and how much -- and it answers worse when the plate
 * is a dark smear or a white blur. Two things are done here before the bytes
 * leave the phone:
 *
 *   1. Downscale to at most MAX_EDGE pixels on the long side and re-encode as
 *      JPEG, stepping quality and size down until the upload is under
 *      MAX_UPLOAD_CHARS. The dishes are still obvious at 896px; the upload
 *      drops from several megabytes to about a hundred kilobytes, which on
 *      Lagos mobile data is the difference between a few seconds and a
 *      minute.
 *   2. Fix brightness and contrast when they are off: a levels stretch when
 *      the histogram is squashed, a gamma lift when the picture is dark, a
 *      gamma drop when it is washed out. Colour is deliberately NOT touched.
 *      Colour is evidence -- jollof is red, white rice is white, egusi is
 *      yellow -- and a white-balance pass that greys a plate of stew to
 *      "correct" a warm bulb destroys the very thing the model reads. A
 *      strong cast is measured and reported to the model in words instead.
 *
 * The decision -- what the picture's statistics are, and what correction they
 * call for -- is pure arithmetic on a pixel array and is tested in Node
 * without a browser (tests/imagePrep.test.js). The canvas work that produces
 * that array and encodes the result lives in prepareImage at the bottom, is
 * only ever called in the browser, and is kept thin. Nothing in this module
 * touches `document` or `window` at import time, so it loads under plain
 * Node like every other src/lib module.
 */

/** Long side of the image sent to the model, in pixels. 896 is Gemma's
 *  native tile; a plate's dishes are obvious well below it. */
export const MAX_EDGE = 896
/** JPEG quality for the upload. 0.8 keeps textures (rice grains, sauce) without the artefacts of 0.7. */
export const JPEG_QUALITY = 0.8
/** The upload budget, in base64 characters: about 130 KB. Under NVIDIA NIM's
 *  inline-image ceiling with margin, and two or three seconds on Lagos
 *  mobile data rather than twenty. The ladder below steps down until the
 *  encoding fits. */
export const MAX_UPLOAD_CHARS = 177000
export const ENCODE_LADDER = [
  [MAX_EDGE, JPEG_QUALITY],
  [MAX_EDGE, 0.7],
  [768, 0.7],
  [640, 0.65],
]
/** Long side of the thumbnail kept with the logged meal, in pixels. */
export const THUMB_EDGE = 96
/** A thumbnail data URL longer than this is not stored; the row must stay small. */
export const THUMB_MAX_CHARS = 8000
/** Long side of the second, smaller encoding sent alongside the main one. NVIDIA
 *  NIM takes an inline image only up to about 180 KB; 640px at this quality
 *  lands well under it, and the fallback provider gets a picture rather than
 *  an error. */
export const SMALL_EDGE = 640
export const SMALL_QUALITY = 0.72

/** Rec. 601 luma, the perceptual brightness of a pixel on 0..255. */
export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

/**
 * What the picture's light is like.
 *
 * Reads a sample of pixels (every `step`-th one, chosen so a large image
 * costs about the same as a small one) and reports the luma histogram's
 * shape and the colour balance of its mid-tones.
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} rgba - interleaved RGBA, as getImageData returns
 * @param {number} width
 * @param {number} height
 * @param {{step?: number}} [options] - pixel stride; defaults to one that samples about 40k pixels
 * @returns {{
 *   samples: number, mean: number, median: number, p1: number, p5: number, p95: number, p99: number,
 *   darkFraction: number, brightFraction: number,
 *   channelMeans: {r: number, g: number, b: number}, cast: {kind: 'none'|'warm'|'cool'|'green'|'magenta', strength: number}
 * }}
 */
export function assessExposure(rgba, width, height, { step } = {}) {
  const pixels = Math.max(0, Math.floor(Math.min(rgba.length / 4, width * height)))
  const stride = step && step > 0 ? Math.floor(step) : Math.max(1, Math.floor(pixels / 40000))
  const hist = new Uint32Array(256)
  let samples = 0
  let sum = 0
  let dark = 0
  let bright = 0
  // Colour balance from the mid-tones only: a blown highlight is white and a
  // crushed shadow is black whatever the light was, so both would dilute the
  // measurement of the light itself.
  let midR = 0
  let midG = 0
  let midB = 0
  let mid = 0

  for (let i = 0; i < pixels; i += stride) {
    const o = i * 4
    const r = rgba[o]
    const g = rgba[o + 1]
    const b = rgba[o + 2]
    const y = luma(r, g, b)
    const bin = y < 0 ? 0 : y > 255 ? 255 : Math.round(y)
    hist[bin]++
    sum += y
    samples++
    if (y <= 8) dark++
    if (y >= 247) bright++
    if (y >= 30 && y <= 225) {
      midR += r
      midG += g
      midB += b
      mid++
    }
  }

  if (samples === 0) {
    return {
      samples: 0,
      mean: 0,
      median: 0,
      p1: 0,
      p5: 0,
      p95: 0,
      p99: 0,
      darkFraction: 0,
      brightFraction: 0,
      channelMeans: { r: 0, g: 0, b: 0 },
      cast: { kind: 'none', strength: 0 },
    }
  }

  const percentile = (p) => {
    const target = p * (samples - 1)
    let seen = 0
    for (let v = 0; v < 256; v++) {
      seen += hist[v]
      if (seen > target) return v
    }
    return 255
  }

  const channelMeans =
    mid > 0
      ? { r: midR / mid, g: midG / mid, b: midB / mid }
      : { r: 0, g: 0, b: 0 }

  return {
    samples,
    mean: sum / samples,
    median: percentile(0.5),
    p1: percentile(0.01),
    p5: percentile(0.05),
    p95: percentile(0.95),
    p99: percentile(0.99),
    darkFraction: dark / samples,
    brightFraction: bright / samples,
    channelMeans,
    cast: describeCast(channelMeans),
  }
}

/**
 * Name the colour cast of a light from the mid-tone channel means.
 *
 * Strength is how far the most and least present channels sit from each
 * other, as a ratio minus one: 0 for grey light, about 0.3 under a yellow
 * bulb, 0.5 or more under a single coloured LED. Only reported, never
 * corrected (see the module comment).
 *
 * @param {{r: number, g: number, b: number}} means
 * @returns {{kind: 'none'|'warm'|'cool'|'green'|'magenta', strength: number}}
 */
export function describeCast(means) {
  const { r, g, b } = means
  const lo = Math.min(r, g, b)
  const hi = Math.max(r, g, b)
  if (!(hi > 0) || !(lo > 0)) return { kind: 'none', strength: 0 }
  const strength = hi / lo - 1
  if (strength < CAST_THRESHOLD) return { kind: 'none', strength }
  // Which way it leans: warm when red leads and blue trails, cool the other
  // way round, green or magenta when green is the odd one out.
  if (g === hi && g > r * 1.08 && g > b * 1.08) return { kind: 'green', strength }
  if (g === lo && r > g * 1.08 && b > g * 1.08) return { kind: 'magenta', strength }
  if (r >= b) return { kind: 'warm', strength }
  return { kind: 'cool', strength }
}

// The thresholds. Luma is on 0..255 throughout.
/** A p99 under this means almost nothing in the frame is lit: the photo is
 *  unusable and is not sent without the owner saying so. Brightening it
 *  would only amplify sensor noise into "texture" the model misreads. */
export const UNUSABLE_P99 = 40
/** Below this mean (or median) the picture reads as dark and gets a gamma lift. */
export const DARK_MEAN = 80
export const DARK_MEDIAN = 70
/** Nearly black: brightened as far as the cap allows, and flagged as unreliable. */
export const VERY_DARK_MEAN = 28
/** Above this mean, or with this share of blown pixels, the picture is washed out. */
export const BRIGHT_MEAN = 185
export const BRIGHT_FRACTION = 0.12
/** A p1..p99 span narrower than this is a squashed histogram worth stretching. */
export const FLAT_RANGE = 110
/** A cast weaker than this is ordinary light and not mentioned. */
export const CAST_THRESHOLD = 0.18
/** The darkest a gamma lift goes. Lower amplifies sensor noise faster than it reveals food. */
export const MIN_GAMMA = 0.5
/** The strongest gamma drop for a washed-out shot. */
export const MAX_GAMMA = 1.8
/** Where a gamma lift tries to put the median, as a fraction of full scale. */
const TARGET_MID = 0.45
const TARGET_MID_BRIGHT = 0.6

/**
 * Decide what, if anything, to do about the light.
 *
 * Returns the levels (black and white points) and the gamma to apply, and a
 * label the UI and the prompt both use. `apply` is false when the picture
 * is fine as it is -- most daylight photos -- so a good shot is sent
 * untouched rather than re-encoded through a needless correction.
 *
 * @param {ReturnType<typeof assessExposure>} stats
 * @returns {{label: 'good'|'dark'|'very-dark'|'bright'|'low-contrast'|'unusable', apply: boolean, black: number, white: number, gamma: number, reason: string}}
 */
export function planCorrection(stats) {
  const none = { label: 'good', apply: false, black: 0, white: 255, gamma: 1, reason: 'exposure within range' }
  if (!stats || !(stats.samples > 0)) return none

  const { mean, median, p1, p99, brightFraction } = stats
  const span = p99 - p1

  if (p99 < UNUSABLE_P99) {
    return {
      label: 'unusable',
      apply: false,
      black: 0,
      white: 255,
      gamma: 1,
      reason: `p99 luma ${p99}: nothing in the frame is lit`,
    }
  }

  // Levels: pull the darkest real tone to black and the brightest to white,
  // but never move either far. A black point past 40 would crush shadow
  // detail (a dark stew in a dark bowl) and a white point under 200 would
  // blow out anything pale (rice, bread).
  const black = Math.min(40, Math.max(0, p1))
  const white = Math.max(200, Math.min(255, p99))

  if (mean < VERY_DARK_MEAN) {
    return {
      label: 'very-dark',
      apply: true,
      black,
      white,
      gamma: MIN_GAMMA,
      reason: `mean luma ${mean.toFixed(0)}: nearly black, lifted as far as the noise cap allows`,
    }
  }

  if (mean < DARK_MEAN || median < DARK_MEDIAN) {
    // Choose the gamma that puts the median at TARGET_MID, measured after the
    // levels stretch so the two corrections do not double up.
    const m = clamp01((median - black) / (white - black))
    const gamma = clamp(gammaToReach(m, TARGET_MID), MIN_GAMMA, 1)
    return {
      label: 'dark',
      apply: true,
      black,
      white,
      gamma,
      reason: `median luma ${median}: dark, gamma ${gamma.toFixed(2)} lift`,
    }
  }

  if (mean > BRIGHT_MEAN || brightFraction > BRIGHT_FRACTION) {
    const m = clamp01((median - black) / (white - black))
    const gamma = clamp(gammaToReach(m, TARGET_MID_BRIGHT), 1, MAX_GAMMA)
    return {
      label: 'bright',
      apply: true,
      black,
      // Blown pixels are gone whatever we do; the white point stays put.
      white: 255,
      gamma,
      reason: `mean luma ${mean.toFixed(0)}, ${(brightFraction * 100).toFixed(0)}% blown: washed out, gamma ${gamma.toFixed(2)} drop`,
    }
  }

  if (span < FLAT_RANGE) {
    return {
      label: 'low-contrast',
      apply: true,
      black,
      white,
      gamma: 1,
      reason: `p1..p99 span ${span}: flat, stretched to ${black}..${white}`,
    }
  }

  return none
}

/** The gamma that maps a mid-tone `m` (0..1) onto `target` (0..1). 1 when it cannot be computed. */
export function gammaToReach(m, target) {
  if (!(m > 0) || !(m < 1) || !(target > 0) || !(target < 1)) return 1
  return Math.log(target) / Math.log(m)
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function clamp01(v) {
  return clamp(Number.isFinite(v) ? v : 0, 0, 1)
}

/**
 * The 256-entry lookup table for a levels-then-gamma correction.
 *
 * Monotonic, 0 at or below the black point, 255 at or above the white point.
 * One table serves all three channels, which is what keeps hue where it was:
 * the same curve applied to R, G and B changes brightness and contrast and
 * nothing else.
 *
 * @param {{black?: number, white?: number, gamma?: number}} plan
 * @returns {Uint8Array}
 */
export function buildLut({ black = 0, white = 255, gamma = 1 } = {}) {
  const lut = new Uint8Array(256)
  const lo = clamp(black, 0, 254)
  const hi = clamp(white, lo + 1, 255)
  const g = gamma > 0 && Number.isFinite(gamma) ? gamma : 1
  for (let v = 0; v < 256; v++) {
    const t = clamp01((v - lo) / (hi - lo))
    lut[v] = Math.round(Math.pow(t, g) * 255)
  }
  return lut
}

/**
 * Apply a lookup table to every colour channel in place. Alpha is untouched.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {Uint8Array} lut
 * @returns {Uint8ClampedArray|Uint8Array} the same array
 */
export function applyLut(rgba, lut) {
  for (let o = 0; o + 2 < rgba.length; o += 4) {
    rgba[o] = lut[rgba[o]]
    rgba[o + 1] = lut[rgba[o + 1]]
    rgba[o + 2] = lut[rgba[o + 2]]
  }
  return rgba
}

/**
 * The quality report that travels with the photo: to the model, as a line
 * of the prompt, and to the owner, as a chip under the preview.
 *
 * @param {ReturnType<typeof assessExposure>} stats
 * @param {ReturnType<typeof planCorrection>} plan
 * @returns {{lighting: string, corrected: boolean, cast: string, unreliable: boolean, unusable: boolean, note: string}}
 */
export function describeQuality(stats, plan) {
  const cast = stats?.cast?.kind && stats.cast.kind !== 'none' ? stats.cast.kind : 'none'
  const lighting = plan?.label || 'good'
  const corrected = Boolean(plan?.apply)
  const unreliable = lighting === 'very-dark' || lighting === 'unusable'

  const parts = []
  if (lighting === 'unusable') parts.push('Too dark to read; turn on a light or move to a window and try again')
  else if (lighting === 'very-dark') parts.push('Very dark photo, brightened as far as possible; the model may not be sure')
  else if (lighting === 'dark') parts.push('Dark photo, brightened before sending')
  else if (lighting === 'bright') parts.push('Washed-out photo, toned down before sending')
  else if (lighting === 'low-contrast') parts.push('Flat light, contrast stretched before sending')
  else parts.push('Light looks fine')
  if (cast === 'warm') parts.push('warm (yellow) light')
  else if (cast === 'cool') parts.push('cool (blue) light')
  else if (cast === 'green') parts.push('greenish light')
  else if (cast === 'magenta') parts.push('pinkish light')

  return { lighting, corrected, cast, unreliable, unusable: lighting === 'unusable', note: parts.join('; ') }
}

/**
 * Pick the output size: the long side capped at `maxEdge`, never upscaled.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} [maxEdge]
 * @returns {{width: number, height: number, scale: number}}
 */
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const w = Math.max(1, Math.floor(width || 1))
  const h = Math.max(1, Math.floor(height || 1))
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale }
}

/** Bytes a base64 string decodes to. Used to show the upload size and check the cap. */
export function base64Bytes(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return 0
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - padding
}

/** The base64 payload of a data URL, or the string itself when it has no prefix. */
export function stripDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return ''
  const comma = dataUrl.indexOf(',')
  return dataUrl.startsWith('data:') && comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

/** True for a file the browser can decode into pixels. HEIC is left to the browser to refuse. */
export function isSupportedImage(file) {
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('image/')) return true
  // Some desktop browsers hand over a pasted or dragged file with no type.
  return /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(String(file?.name || ''))
}

// ---------------------------------------------------------------------------
// Browser glue. Nothing above this line needs a DOM; nothing below runs in Node.
// ---------------------------------------------------------------------------

/**
 * Decode a File or Blob into something drawImage accepts, honouring the EXIF
 * orientation a phone writes (a portrait shot would otherwise arrive on its
 * side, and the model would read a sideways plate).
 *
 * @param {Blob} blob
 * @returns {Promise<ImageBitmap|HTMLImageElement>}
 */
async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' })
    } catch {
      // Fall through to the <img> path: Safari before 16 rejects the option
      // on some sources, and an undecodable file throws here too.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('That file could not be read as an image. Try a JPEG or PNG.'))
    }
    img.src = url
  })
}

function sourceSize(source) {
  return {
    width: source.naturalWidth || source.width,
    height: source.naturalHeight || source.height,
  }
}

function canvasOf(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function toJpegDataUrl(canvas, quality) {
  return canvas.toDataURL('image/jpeg', quality)
}

/**
 * Everything the capture sheet needs from one picked or taken photo.
 *
 * @param {Blob} blob - the File from an input, a drop, a paste, or a webcam frame
 * @param {{maxEdge?: number, quality?: number, thumbEdge?: number}} [options]
 * @returns {Promise<{
 *   base64: string, mime: 'image/jpeg', width: number, height: number, bytes: number,
 *   small: {base64: string, width: number, height: number, bytes: number},
 *   previewUrl: string, thumbnail: string|null,
 *   stats: ReturnType<typeof assessExposure>, plan: ReturnType<typeof planCorrection>,
 *   quality: ReturnType<typeof describeQuality>
 * }>}
 */
export async function prepareImage(blob, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY, thumbEdge = THUMB_EDGE, maxChars = MAX_UPLOAD_CHARS } = {}) {
  const source = await decode(blob)
  const { width: sw, height: sh } = sourceSize(source)
  const { width, height } = fitWithin(sw, sh, maxEdge)

  const canvas = canvasOf(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  // A JPEG has no alpha; paint black first so a transparent PNG does not
  // become a transparent region the encoder renders as black anyway, only
  // after the statistics have counted it as something else.
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  if (typeof source.close === 'function') source.close()

  const image = ctx.getImageData(0, 0, width, height)
  const stats = assessExposure(image.data, width, height)
  const plan = planCorrection(stats)
  if (plan.apply) {
    applyLut(image.data, buildLut(plan))
    ctx.putImageData(image, 0, 0)
  }

  // Encode, stepping down the ladder until the upload fits the budget. The
  // first rung uses the caller's size and quality; later rungs redraw the
  // corrected canvas smaller.
  let previewUrl = toJpegDataUrl(canvas, quality)
  let base64 = stripDataUrl(previewUrl)
  let sent = { width, height }
  for (const [edge, q] of ENCODE_LADDER.slice(1)) {
    if (base64.length <= maxChars) break
    const r = fitWithin(width, height, edge)
    const c = canvasOf(r.width, r.height)
    c.getContext('2d').drawImage(canvas, 0, 0, r.width, r.height)
    previewUrl = toJpegDataUrl(c, q)
    base64 = stripDataUrl(previewUrl)
    sent = { width: r.width, height: r.height }
  }

  // The smaller encoding, drawn from the corrected canvas so both carry the
  // same light.
  const s = fitWithin(width, height, SMALL_EDGE)
  const smallCanvas = canvasOf(s.width, s.height)
  smallCanvas.getContext('2d').drawImage(canvas, 0, 0, s.width, s.height)
  const smallBase64 = stripDataUrl(toJpegDataUrl(smallCanvas, SMALL_QUALITY))
  const small = { base64: smallBase64, width: s.width, height: s.height, bytes: base64Bytes(smallBase64) }

  let thumbnail = null
  try {
    const t = fitWithin(width, height, thumbEdge)
    const small = canvasOf(t.width, t.height)
    small.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height)
    const url = toJpegDataUrl(small, 0.6)
    thumbnail = url.length <= THUMB_MAX_CHARS ? url : null
  } catch {
    thumbnail = null
  }

  return {
    base64,
    mime: 'image/jpeg',
    width: sent.width,
    height: sent.height,
    bytes: base64Bytes(base64),
    small,
    previewUrl,
    thumbnail,
    stats,
    plan,
    quality: describeQuality(stats, plan),
  }
}

/**
 * One frame from a live webcam <video>, as a Blob the rest of the pipeline
 * accepts. Desktop has no camera app to hand a File over, so the page shows
 * the stream and this takes the picture.
 *
 * @param {HTMLVideoElement} video
 * @returns {Promise<Blob>}
 */
export function captureFrame(video) {
  return new Promise((resolve, reject) => {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) {
      reject(new Error('The camera has not produced a frame yet. Try again in a second.'))
      return
    }
    const canvas = canvasOf(width, height)
    canvas.getContext('2d').drawImage(video, 0, 0, width, height)
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the camera frame.'))), 'image/jpeg', 0.95)
  })
}
