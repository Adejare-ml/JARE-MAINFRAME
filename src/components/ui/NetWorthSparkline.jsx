import { buildSparkline } from '../../lib/sparkline'
import { formatDate } from '../../lib/formatters'
import Money from './Money'

/**
 * A trend line, hand-rolled in SVG -- no chart library exists in this
 * project, and one line does not justify adding one. A plain line, no
 * gradient fill.
 *
 * @param {object} props
 * @param {Array<{snapshot_date: string, total_balance: number}>} props.snapshots - ascending by date
 */
export default function NetWorthSparkline({ snapshots }) {
  const width = 320
  const height = 80

  if (!snapshots || snapshots.length < 2) {
    return <p className="text-body-sm text-muted">Not enough history yet to show a trend. Check back after a few days.</p>
  }

  const points = snapshots.map((s) => ({ date: s.snapshot_date, total: s.total_balance }))
  const { path, min, max, coords } = buildSparkline(points, { width, height })
  const latest = coords[coords.length - 1]

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none" aria-hidden="true">
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {latest && <circle cx={latest.x} cy={latest.y} r="3" fill="var(--color-accent)" />}
      </svg>
      <div className="flex justify-between gap-3 type-data text-muted-dim mt-1">
        <span className="truncate">
          {formatDate(snapshots[0].snapshot_date)} · <Money amount={min} kobo={false} tone="muted" />
        </span>
        <span className="truncate text-right">
          {formatDate(snapshots[snapshots.length - 1].snapshot_date)} · <Money amount={max} kobo={false} tone="muted" />
        </span>
      </div>
    </div>
  )
}
