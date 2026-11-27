import { formatNairaSigned } from '../../lib/formatters'
import { toneText } from './tone'

/**
 * An inline naira amount: Inter weight 500 (so the ₦ glyph comes from Inter's
 * latin-ext face, never mono), tabular, never wraps, `.money` so zen mode
 * blurs it. Kobo shown by default: the ledger is exact.
 *
 * Expense amounts stay `default` (foreground). Only income and positive
 * deltas take `positive`.
 *
 * @param {object} props
 * @param {number} props.amount
 * @param {boolean} [props.kobo] - default true
 * @param {boolean} [props.sign] - leading + on positive amounts; negatives always carry U+2212
 * @param {'default'|'muted'|'positive'|'warn'|'danger'} [props.tone]
 * @param {string} [props.className] - layout or size only (e.g. text-heading)
 */
export default function Money({ amount, kobo = true, sign = false, tone = 'default', className = '' }) {
  return (
    <span className={`money font-medium whitespace-nowrap tabular-nums ${toneText(tone)} ${className}`}>
      {formatNairaSigned(amount, { kobo, sign })}
    </span>
  )
}
