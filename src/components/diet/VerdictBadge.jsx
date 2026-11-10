/**
 * fits / tight / over, as a small coloured label. Text as well as colour,
 * so the verdict does not depend on telling green from orange.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
const STYLES = {
  fits: 'bg-accent/15 text-accent border-accent/30',
  tight: 'bg-orange-400/15 text-orange-300 border-orange-400/30',
  over: 'bg-red-400/15 text-red-300 border-red-400/30',
}

export default function VerdictBadge({ verdict }) {
  if (!verdict || !STYLES[verdict]) return null
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-extrabold uppercase tracking-wider ${STYLES[verdict]}`}>{verdict}</span>
}
