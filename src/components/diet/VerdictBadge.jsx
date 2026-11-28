import Badge from '../ui/Badge'

/**
 * fits / tight / over, as a small coloured label. Text as well as colour,
 * so the verdict does not depend on telling green from orange.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
const TONES = { fits: 'accent', tight: 'warn', over: 'danger' }

export default function VerdictBadge({ verdict }) {
  if (!verdict || !TONES[verdict]) return null
  return <Badge label={verdict} tone={TONES[verdict]} />
}
