/**
 * A 4px track in surface-2 with a fill in accent, warn or danger. The fill
 * moves by transform (scaleX), so a new value eases over --dur-sheet without
 * animating layout.
 *
 * @param {object} props
 * @param {number} props.value
 * @param {number} [props.max] - default 100
 * @param {'accent'|'warn'|'danger'} [props.tone]
 * @param {string} [props.label] - accessible name for the progressbar
 */
const FILL = { accent: 'bg-accent', warn: 'bg-warn', danger: 'bg-danger' }

export default function ProgressBar({ value, max = 100, tone = 'accent', label }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, Number(value) / max)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(Math.min(max, Math.max(0, Number(value) || 0)))}
      className="h-1 w-full bg-surface-2 rounded-full overflow-hidden"
    >
      <div
        className={`progress-fill h-full w-full rounded-full ${FILL[tone] || FILL.accent}`}
        style={{ transform: `scaleX(${ratio})` }}
      />
    </div>
  )
}
