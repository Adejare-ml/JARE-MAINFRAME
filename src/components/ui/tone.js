/**
 * Colour means state (docs/design-system.md). One map from a tone name to
 * its text class, shared by the primitives so no page invents its own.
 * `positive` is an alias of `accent`: income and positive deltas only.
 */
export const TONE_TEXT = {
  default: 'text-foreground',
  muted: 'text-muted',
  accent: 'text-accent',
  positive: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
  negative: 'text-danger',
}

export const toneText = (tone) => TONE_TEXT[tone] || TONE_TEXT.default
