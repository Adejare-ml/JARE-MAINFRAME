import { formatNairaSigned, formatNairaWhole, formatNairaCompact } from '../../lib/formatters'
import { toneText } from './tone'
import Label from './Label'

/**
 * A big figure with a `label` above it: the hero number of a page (`display`,
 * one per page at most) or a panel readout (`figure`).
 *
 * The naira overflow rule (docs/design-system.md) lives here so no page
 * re-derives it. Figures never wrap, truncate or scroll:
 *   display: whole naira; 32px up to 11 characters, 26px for 12-14, 22px for
 *     15+; ₦1,000,000,000 and over in compact form ("₦1.23B").
 *   figure: 22px up to 10 characters, 18px beyond; kobo only under ₦100,000.
 * The exact amount always goes in `title` and `aria-label`.
 *
 * @param {object} props
 * @param {number|string} props.value
 * @param {'naira'|'number'|'percent'} [props.kind]
 * @param {React.ReactNode} [props.label]
 * @param {React.ReactNode} [props.unit] - trailing unit for numbers ("kcal", "left")
 * @param {'display'|'figure'} [props.size]
 * @param {'default'|'muted'|'positive'|'warn'|'danger'} [props.tone]
 * @param {React.ReactNode} [props.sub] - one body-sm line under the figure
 */
export default function Readout({ value, kind = 'naira', label, unit, size = 'figure', tone = 'default', sub }) {
  const n = Number(value)
  let text
  let exact
  if (kind === 'naira') {
    exact = formatNairaSigned(n)
    if (size === 'display') text = Math.abs(n) >= 1e9 ? formatNairaCompact(n) : formatNairaWhole(n)
    else text = formatNairaSigned(n, { kobo: Math.abs(n) < 100000 })
  } else if (kind === 'percent') {
    text = `${Number.isFinite(n) ? Math.round(n) : 0}%`
    exact = text
  } else {
    text = Number.isFinite(n) ? n.toLocaleString('en-NG') : String(value ?? '')
    exact = text
  }

  const len = [...text].length
  const sizeClass =
    size === 'display'
      ? len <= 11
        ? 'text-display'
        : len <= 14
          ? 'text-[26px] leading-8 font-semibold tracking-[-0.02em]'
          : 'text-figure'
      : len <= 10
        ? 'text-figure'
        : 'text-[18px] leading-6 font-semibold tracking-[-0.01em]'

  const isMoney = kind === 'naira'
  const fullLabel = typeof label === 'string' ? `${label}: ${exact}` : exact

  return (
    <div className="min-w-0">
      {label && <Label as="p" className="mb-1">{label}</Label>}
      <p className="whitespace-nowrap" title={exact} aria-label={fullLabel}>
        <span className={`${isMoney ? 'money' : ''} tabular-nums ${sizeClass} ${toneText(tone)}`}>{text}</span>
        {unit && <span className="text-body-sm text-muted ml-1.5">{unit}</span>}
      </p>
      {sub && <p className="text-body-sm text-muted mt-1">{sub}</p>}
    </div>
  )
}
