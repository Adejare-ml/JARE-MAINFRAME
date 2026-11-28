/**
 * Where a ledger row came from, in one muted `data` line: "GTBank alert ·
 * 09:41", "Manual · 14:02". Built only from fields that exist; renders
 * nothing when there is nothing true to say. Never fabricated.
 *
 * @param {object} props
 * @param {string} [props.source] - transactions.source ('manual', 'email', a bank slug...)
 * @param {string} [props.at] - an HH:mm[:ss] time (transactions.transaction_time) or an ISO timestamp
 */
const SOURCES = {
  manual: 'Manual',
  email: 'Email alert',
  gmail: 'Email alert',
  gtbank: 'GTBank alert',
  opay: 'OPay alert',
  import: 'Import',
  csv: 'Import',
  recurring: 'Recurring',
  adjustment: 'Adjustment',
}

export function provenanceText(source, at) {
  const src = typeof source === 'string' && source.trim()
    ? SOURCES[source.trim().toLowerCase()] || `${source.trim().charAt(0).toUpperCase()}${source.trim().slice(1)}`
    : null
  let time = null
  if (typeof at === 'string' && at) {
    if (/^\d{2}:\d{2}/.test(at)) time = at.slice(0, 5)
    else {
      const d = new Date(at)
      if (!Number.isNaN(d.getTime())) time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
  }
  return [src, time].filter(Boolean).join(' · ')
}

export default function Provenance({ source, at }) {
  const text = provenanceText(source, at)
  if (!text) return null
  return <span className="type-data text-muted-dim truncate block">{text}</span>
}
