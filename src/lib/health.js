/**
 * What the app can say about its own automation.
 *
 * Six scheduled scripts feed this app, and for five weeks in 2026 none of
 * them ran: the failure issues went to GitHub, the app kept drawing the
 * shape of automation -- an empty recap card, a flat net-worth line -- and
 * nothing on screen said why. This turns sync_runs rows (written by
 * scripts/lib/recordRun.mjs) into one status per job for Settings → System.
 *
 * Pure: rows and a clock in, words out. The component only fetches.
 */

export const STATUS = { OK: 'ok', FAILING: 'failing', STALE: 'stale', NEVER: 'never' }

/** Every scheduled job, with how long silence is normal before it is worrying. */
export const JOBS = [
  // Four runs a day, 8am-6pm Lagos; the overnight gap alone is fourteen hours.
  // The mailbox is read by the owner's Claude scheduled task (once a day at
  // 08:00 UTC) since the token-based Gmail sync was retired; it records its
  // run through record_sync_run (migration 032).
  { id: 'claude-audit', label: 'Bank alerts (Claude audit)', staleAfterHours: 30 },
  // 'draft-day' was retired with its schedule on 26 Sep 2026 (see
  // .github/workflows/draft-day.yml); its old rows stay in sync_runs, unread.
  { id: 'verify-repo', label: 'Repo verification', staleAfterHours: 30 },
  { id: 'snapshot-net-worth', label: 'Net worth snapshot', staleAfterHours: 30 },
  { id: 'weekly-recap', label: 'Weekly recap', staleAfterHours: 8 * 24 },
  { id: 'plan-month', label: 'Month plan', staleAfterHours: 33 * 24 },
  // Every morning at 07:30 Lagos.
  { id: 'remind', label: 'Morning reminder', staleAfterHours: 30 },
]

export function hoursBetween(from, to) {
  return (new Date(to) - new Date(from)) / 3_600_000
}

/**
 * One status per job from whatever sync_runs rows are on hand. Rows may
 * arrive in any order; the latest finished_at decides.
 *
 * @param {Array<{job: string, finished_at: string, ok: boolean, summary?: string|null}>} rows
 * @param {Date|string|number} [now]
 * @param {typeof JOBS} [jobs]
 * @returns {Array<{id: string, label: string, status: string, lastRun: object|null, lastOk: object|null, lastFailure: object|null}>}
 */
export function summarizeRuns(rows = [], now = new Date(), jobs = JOBS) {
  const byJob = new Map()
  for (const row of rows || []) {
    if (!row || typeof row.job !== 'string') continue
    if (!byJob.has(row.job)) byJob.set(row.job, [])
    byJob.get(row.job).push(row)
  }

  return jobs.map((job) => {
    const runs = (byJob.get(job.id) || [])
      .slice()
      .sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at))
    const lastRun = runs[0] || null
    const lastOk = runs.find((r) => r.ok) || null
    const lastFailure = runs.find((r) => !r.ok) || null

    let status = STATUS.NEVER
    if (lastRun) {
      if (!lastRun.ok) status = STATUS.FAILING
      else if (hoursBetween(lastRun.finished_at, now) > job.staleAfterHours) status = STATUS.STALE
      else status = STATUS.OK
    }

    return { id: job.id, label: job.label, status, lastRun, lastOk, lastFailure }
  })
}

/**
 * The mailbox cursor as a second signal: whoever reads the mailbox stamps
 * last_checked whether or not anything new arrived, so a quiet mailbox
 * and a dead reader look the same on the ledger but not here. Since the
 * Claude audit took over (032), that stamp comes once a day, so the
 * patience matches its 30 hours.
 *
 * @param {{last_checked?: string|null, last_sync?: string|null}|null} integration
 * @param {Date|string|number} [now]
 */
export function gmailCursorStatus(integration, now = new Date()) {
  const caughtUpTo = integration?.last_sync || null
  if (!integration?.last_checked) return { status: STATUS.NEVER, checkedHoursAgo: null, caughtUpTo }
  const checkedHoursAgo = hoursBetween(integration.last_checked, now)
  return { status: checkedHoursAgo > 30 ? STATUS.STALE : STATUS.OK, checkedHoursAgo, caughtUpTo }
}

/** One word for the whole system: the worst job wins. */
export function overallStatus(jobStatuses) {
  if (jobStatuses.some((j) => j.status === STATUS.FAILING)) return STATUS.FAILING
  if (jobStatuses.some((j) => j.status === STATUS.STALE)) return STATUS.STALE
  if (jobStatuses.length > 0 && jobStatuses.every((j) => j.status === STATUS.NEVER)) return STATUS.NEVER
  return STATUS.OK
}
