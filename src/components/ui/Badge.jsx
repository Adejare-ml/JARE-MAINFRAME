/**
 * A small status or category tag: the `label` step, 4px radius, a 1px
 * border in its tone colour. Category badges are neutral (a category is
 * not a state); pass `tone` only when the badge reports one.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.label]
 * @param {string} [props.category] - shown when no label is given
 * @param {'default'|'accent'|'warn'|'danger'} [props.tone]
 */
const TONES = {
  default: 'text-muted border-border',
  accent: 'text-accent border-accent',
  warn: 'text-warn border-warn',
  danger: 'text-danger border-danger',
}

export default function Badge({ label, category, tone = 'default' }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-chip border type-label whitespace-nowrap ${TONES[tone] || TONES.default}`}>
      {label || category}
    </span>
  )
}
