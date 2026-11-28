/**
 * An 8px state dot. Solid for a settled state, hollow for one that is not
 * (stale, never ran, offline). Always paired with a word: colour is never the
 * only carrier of state, so this is aria-hidden.
 *
 * Status names follow STATUS in src/lib/health.js, plus `offline` and
 * `loading`; the plain tones (`accent`, `warn`, `danger`, `muted`) cover
 * toasts and inline status.
 *
 * @param {object} props
 * @param {string} props.status
 * @param {boolean} [props.pulseOnce] - one 600ms opacity pulse (a sync just completed); change `key` to replay
 */
const STYLE = {
  ok: 'bg-accent',
  accent: 'bg-accent',
  attention: 'bg-warn',
  warn: 'bg-warn',
  failing: 'bg-danger',
  danger: 'bg-danger',
  stale: 'border-2 border-warn',
  never: 'border-2 border-muted',
  offline: 'border-2 border-muted',
  loading: 'bg-muted',
  muted: 'bg-muted',
}

export default function StatusDot({ status = 'muted', pulseOnce = false, className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${STYLE[status] || STYLE.muted} ${pulseOnce ? 'pulse-once' : ''} ${className}`}
    />
  )
}
