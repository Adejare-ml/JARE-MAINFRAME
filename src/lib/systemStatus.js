/**
 * What the status rail says, as pure functions: sync_runs rows and a clock
 * in, a dot and a few plain words out. src/lib/useSystemStatus.js fetches;
 * StatusRail and the sidebar footer render. Tested in tests/systemStatus.test.js.
 */
import { summarizeRuns, overallStatus, STATUS } from './health.js'
import { formatRailTime, shortAge } from './formatters.js'

/** Short plain names for the rail and the sidebar's job list. */
export const JOB_SHORT_NAMES = {
  'claude-audit': 'Ledger',
  'verify-repo': 'Repo check',
  'snapshot-net-worth': 'Net worth',
  reconcile: 'Reconcile',
  'weekly-recap': 'Weekly recap',
  'plan-month': 'Month plan',
  remind: 'Reminder',
  backup: 'Backup',
}

export const shortName = (job) => JOB_SHORT_NAMES[job?.id] || job?.label || 'Job'

/** The job the rail times itself by: the bank-alert audit, which feeds the ledger. */
const PRIMARY_JOB = 'claude-audit'

/**
 * @param {object} input
 * @param {boolean} input.available - sync_runs.job exists (migration 025)
 * @param {boolean} input.loading - first fetch not back yet
 * @param {boolean} input.offline - navigator.onLine false, or the fetch failed
 * @param {Array} input.rows - sync_runs rows
 * @param {Date} [input.now]
 * @returns {{show: boolean, status: string|null, text: string, jobs: Array}}
 *   show false means wordmark only (not migrated)
 */
export function railState({ available, loading, offline, rows = [], now = new Date() }) {
  if (!available) return { show: false, status: null, text: '', jobs: [] }
  if (loading) return { show: true, status: 'loading', text: '', jobs: [] }

  const jobs = summarizeRuns(rows, now)
  const latest = rows
    .filter((r) => r && r.finished_at)
    .reduce((max, r) => (!max || r.finished_at > max ? r.finished_at : max), null)

  if (offline) {
    return { show: true, status: 'offline', text: latest ? `Offline, last ${formatRailTime(latest, now)}` : 'Offline', jobs }
  }

  const overall = overallStatus(jobs)
  const primary = jobs.find((j) => j.id === PRIMARY_JOB)

  if (overall === STATUS.FAILING) {
    const worst = jobs.find((j) => j.status === STATUS.FAILING || j.suspect)
    const text = worst?.id === PRIMARY_JOB ? 'Audit failing' : `${shortName(worst)} failing`
    return { show: true, status: 'failing', text, jobs }
  }
  if (overall === STATUS.STALE) {
    const worst = jobs.find((j) => j.status === STATUS.STALE)
    return { show: true, status: 'stale', text: `${shortName(worst)} stale ${shortAge(worst?.lastRun?.finished_at, now)}`, jobs }
  }
  if (overall === STATUS.ATTENTION) {
    const n = jobs.filter((j) => j.status === STATUS.ATTENTION).length
    return { show: true, status: 'attention', text: `${n} item${n === 1 ? '' : 's'} to review`, jobs }
  }
  if (overall === STATUS.NEVER) return { show: true, status: 'never', text: 'No runs yet', jobs }

  const at = primary?.lastRun?.finished_at || latest
  return { show: true, status: 'ok', text: at ? `${shortName(primary || { id: PRIMARY_JOB })} ${formatRailTime(at, now)}` : 'All systems OK', jobs }
}

/** The newest finished_at in a set of rows, for detecting a fresh sync. */
export function latestRun(rows = []) {
  return rows.reduce((max, r) => (r?.finished_at && (!max || r.finished_at > max) ? r.finished_at : max), null)
}
