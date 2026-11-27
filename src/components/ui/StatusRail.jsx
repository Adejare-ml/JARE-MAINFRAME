import { Link } from 'react-router-dom'
import { useSystemStatus } from '../../lib/useSystemStatus'
import { formatRailTime } from '../../lib/formatters'
import { shortName } from '../../lib/systemStatus'
import StatusDot from './StatusDot'

/**
 * The mobile status rail: the middle of the 48px header. A dot and a few
 * plain words about whether the app's data is current ("Ledger 09:14",
 * "Ledger stale 2d", "Offline, last 09:14"), linking to Settings → System.
 * Never a ticking clock, never "live", never money. Renders nothing when
 * sync_runs is not migrated (the header then shows the wordmark only).
 */
export default function StatusRail() {
  const { rail, pulseKey } = useSystemStatus()
  if (!rail.show) return null
  return (
    <Link
      to="/settings#system"
      aria-label={rail.text ? `System status: ${rail.text}. Open Settings, System.` : 'System status. Open Settings, System.'}
      className="flex items-center gap-2 min-w-0 min-h-12 px-2 rounded-control hover:bg-surface-2"
    >
      <StatusDot key={pulseKey} status={rail.status} pulseOnce={pulseKey > 0} />
      {rail.text && <span className="type-data text-muted truncate">{rail.text}</span>}
    </Link>
  )
}

/**
 * The desktop form, in the sidebar footer: every job as dot, short name and
 * last-run time.
 */
export function StatusJobList() {
  const { rail, pulseKey } = useSystemStatus()
  if (!rail.show) return null
  if (rail.status === 'loading') {
    return (
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusDot status="loading" />
      </div>
    )
  }
  return (
    <Link to="/settings#system" className="block px-3 py-2 rounded-control hover:bg-surface-2" aria-label="System status. Open Settings, System.">
      <p className="flex items-center gap-2 mb-1.5">
        <StatusDot key={pulseKey} status={rail.status} pulseOnce={pulseKey > 0} />
        <span className="type-data text-muted truncate">{rail.text}</span>
      </p>
      <ul className="space-y-0.5">
        {rail.jobs.map((job) => (
          <li key={job.id} className="flex items-center gap-2 type-data text-muted-dim">
            <StatusDot status={job.suspect ? 'failing' : job.status} />
            <span className="truncate flex-1">{shortName(job)}</span>
            <span className="whitespace-nowrap">{job.lastRun ? formatRailTime(job.lastRun.finished_at) : 'Never'}</span>
          </li>
        ))}
      </ul>
    </Link>
  )
}
