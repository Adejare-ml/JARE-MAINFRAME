/**
 * WCAG contrast, computed rather than eyeballed.
 *
 * Every prior contrast fix in this app (Stage O's toast/Budget red, the
 * `--color-muted-dim`/`--color-hint` tokens documented in index.css) was
 * verified by hand-calculating the same relative-luminance formula this
 * file now runs as code. This exists so a new color pair -- the light-theme
 * palette in Stage 6 -- can be checked by a test instead of arithmetic done
 * in a comment, the same way this project already checks arithmetic
 * everywhere else it can.
 *
 * Standard sRGB relative luminance + WCAG contrast ratio. No dependency:
 * this is the entire spec, not an approximation of it.
 */

/** One 0-255 channel to its linear-light value. */
function linearizeChannel(channel) {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * @param {string} hex - '#rgb' or '#rrggbb'
 * @returns {{r: number, g: number, b: number}}
 */
export function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim()
  const full = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean
  const num = parseInt(full, 16)
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 * @param {string} hex
 * @returns {number}
 */
export function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b)
}

/**
 * WCAG contrast ratio between two colors, 1 (identical) to 21 (black/white).
 * Order does not matter -- the formula is symmetric in the lighter/darker
 * pair, not in argument order.
 *
 * @param {string} hex1
 * @param {string} hex2
 * @returns {number}
 */
export function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1)
  const l2 = relativeLuminance(hex2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/** The floor WCAG AA sets for normal-size text. Large/bold text and UI
 *  components are allowed a lower 3:1, which this app has not needed to
 *  invoke anywhere yet. */
export const AA_TEXT_MINIMUM = 4.5
