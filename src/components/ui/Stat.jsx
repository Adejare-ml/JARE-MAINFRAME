import Label from './Label'
import { toneText } from './tone'

/**
 * A compact label and value pair for grids (three wallet totals, In / Out).
 * The value is a node: pass a <Money> for amounts so zen mode and the ₦ rule
 * apply.
 *
 * @param {object} props
 * @param {React.ReactNode} props.label
 * @param {React.ReactNode} props.value
 * @param {'default'|'muted'|'positive'|'warn'|'danger'} [props.tone]
 */
export default function Stat({ label, value, tone = 'default' }) {
  return (
    <div className="min-w-0">
      <Label as="p" className="truncate">{label}</Label>
      <p className={`text-heading font-medium mt-0.5 whitespace-nowrap ${toneText(tone)}`}>{value}</p>
    </div>
  )
}
