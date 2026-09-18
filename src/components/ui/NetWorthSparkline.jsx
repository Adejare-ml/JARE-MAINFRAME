import { buildSparkline } from '../../lib/sparkline'
import { formatNaira, formatDate } from '../../lib/formatters'

/**
 * A trend line, hand-rolled in SVG -- no chart library exists in this
 * project, and one line does not justify adding one.
 *
 * @param {object} props
 * @param {Array<{snapshot_date: string, total_balance: number}>} props.snapshots - ascending by date
 */
export default function NetWorthSparkline({ snapshots }) {
  const width = 320
  const height = 80

  if (!snapshots || snapshots.length < 2) {
    return (
      <p className="text-xs text-muted-dim">
        Not enough history yet to show a trend — check back after a few days.
      </p>
    )
  }

  const points = snapshots.map((s) => ({ date: s.snapshot_date, total: s.total_balance }))
  const { path, areaPath, min, max, coords } = buildSparkline(points, { width, height })
  const latest = coords[coords.length - 1]

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none">
        <defs>
          <linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#netWorthFill)" stroke="none" />
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
        {latest && <circle cx={latest.x} cy={latest.y} r="3" fill="var(--color-accent)" />}
      </svg>
      <div className="flex justify-between text-[10px] text-muted-dim mt-1">
        <span>{formatDate(snapshots[0].snapshot_date)} · {formatNaira(min)}</span>
        <span>{formatDate(snapshots[snapshots.length - 1].snapshot_date)} · {formatNaira(max)}</span>
      </div>
    </div>
  )
}
