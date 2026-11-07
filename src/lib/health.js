/**
 * What the app can say about its own automation.
 *
 * Six scheduled scripts feed this app, and for five weeks in 2026 none of
 * them ran: the failure issues went to GitHub, the app kept drawing the
 * shape of automation -- an empty recap card, a flat net-worth line -- and
 * nothing on screen said why. This turns sync_runs rows (written by
 * scripts/lib/recordRun.mjs) into one status per job for Settings → System.
 *
 * A second lesson came later. Two jobs record ok=false for things that are
 * not failures of the job: the reconciliation (040) whenever the ledger and
 * a bank disagree, and the backup until its repository exists. Both painted
 * a permanent red, so red stopped meaning anything and the one alarm that
 * matters -- the bank-alert audit going quiet -- was ignored along with it.
 * Hence ATTENTION: the job ran and found something to look at. Red is kept
 * for a job that is broken or has stopped.
 *
 * Pure: rows and a clock in, words out. The component only fetches.
 */

export const STATUS = {
  OK: 'ok',
  FAILING: 'failing',
  STALE: 'stale',
  NEVER: 'never',
  /** The job ran on time and reported a data problem for the owner, not a
   *  fault of its own: a balance that disagrees with the bank, a missed
   *  alert, a backup repository not yet created. Amber, never red. */
  ATTENTION: 'attention',
}

/**
 * The reconciliation's summary, as 040_reconcile_balances.sql writes it:
 *
 *   "6 wallet(s) checked; OPay off by -3200.00 (ledger …); GTBank: 2 missed
 *    alert(s) around 2026-10-02, 2026-10-05"
 *   "6 wallet(s) checked, ledger and bank alerts agree"
 *
 * Segments are joined with "; ". A drift segment carries " off by ", a gap
 * segment "missed alert". record_sync_run keeps 500 characters, so the last
 * segment may be cut mid-phrase; the tests pin the exact 040 strings.
 *
 * @param {string|null|undefined} summary
 * @returns {{drifts: string[], gaps: string[], other: string[], agree: boolean}|null}
 *   null when the text is not a reconcile report (a crash message, for one)
 */
export function readReconcileSummary(summary) {
  const text = String(summary || '')
  if (!/^\d+ wallet\(s\) checked/.test(text)) return null
  const agree = /, ledger and bank alerts agree$/.test(text)
  const segments = text
    .replace(/, ledger and bank alerts agree$/, '')
    .split('; ')
    .slice(1)
    .map((s) => s.trim())
    .filter(Boolean)
  const drifts = segments.filter((s) => s.includes(' off by '))
  // "missed", not "missed alert(s)": the cap can cut the phrase itself.
  const gaps = segments.filter((s) => /\bmissed\b/.test(s))
  const other = segments.filter((s) => !drifts.includes(s) && !gaps.includes(s))
  return { drifts, gaps, other, agree }
}

/**
 * The backup's summary when the repository and token are not set up yet
 * (scripts/backup.mjs records ok=false with "not configured: …" on purpose).
 * That is a setup step for the owner, not a broken job.
 */
export function readBackupSummary(summary) {
  const text = String(summary || '')
  if (!/^not configured\b/i.test(text)) return null
  return { setup: true, drifts: [], gaps: [], other: [text] }
}

/**
 * The bank-alert audit's summary, as docs/routine-prompt.md step 3 has the
 * Routine record it:
 *
 *   "14 mails found (9 debit, 5 credit) for 2026-10-17 to 2026-10-18;
 *    9 recorded, 4 already there, 1 skipped: stanbic statement"
 *
 * The prompt also tells the Routine to record ok=false whenever one alert
 * was skipped, which used to paint "Bank alerts are failing" over a morning
 * on which the mailbox was read in full. A run that found mail and recorded
 * some of it is a run with a note, not a failure.
 *
 * @returns {{found: number|null, recorded: number|null, already: number|null, skipped: number|null}}
 */
export function readAuditSummary(summary) {
  const text = String(summary || '')
  const num = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  return {
    found: num(/(\d+)\s+mails?\s+found\b/i),
    recorded: num(/(\d+)\s+recorded\b/i),
    already: num(/(\d+)\s+already\s+there\b/i),
    skipped: num(/(\d+)\s+skipped\b/i),
  }
}

/** How many alerts an audit run recorded, or null when the summary does not say. */
export function recordedCount(summary) {
  return readAuditSummary(summary).recorded
}

/**
 * A not-ok audit row read as a report: ATTENTION when the mailbox was
 * clearly read (mail was found and something was recorded or already
 * there), FAILING otherwise (the search failed, nothing parsed, or the
 * Routine itself said "check the Gmail connector").
 */
function readAuditReport(summary) {
  const parsed = readAuditSummary(summary)
  const read = (parsed.found || 0) > 0 && (parsed.recorded || 0) + (parsed.already || 0) > 0
  if (!read) return null
  const note = String(summary || '').match(/\d+\s+skipped\b[^;]*/i)
  return { drifts: [], gaps: [], other: [note ? note[0] : 'some alerts were skipped'], agree: false }
}

/** Every scheduled job, with how long silence is normal before it is worrying. */
export const JOBS = [
  // The mailbox is read by the owner's Claude scheduled task, once a day at
  // 08:00 UTC, since the token-based Gmail sync was retired; it records its
  // run through record_sync_run (migration 032). Thirty hours of patience
  // covers a late start.
  { id: 'claude-audit', label: 'Bank alerts (Claude audit)', staleAfterHours: 30, readReport: readAuditReport },
  // 'draft-day' and 'gmail-sync' were retired on 26 and 23 Sep 2026 with
  // the Google token; their old rows stay in sync_runs, unread.
  { id: 'verify-repo', label: 'Repo verification', staleAfterHours: 30 },
  // Runs inside the database since 28 Sep 2026 (pg_cron, 10:00 UTC,
  // migration 037); records under the same name as the Actions script did.
  { id: 'snapshot-net-worth', label: 'Net worth snapshot', staleAfterHours: 30 },
  // Also pg_cron (10:30 UTC, migration 040): ledger balances against the
  // banks' stated ones, and missed alerts between consecutive ones. A
  // not-ok row here is a number to chase, not a job to restart: a drift is
  // red, a missed alert is amber.
  { id: 'reconcile', label: 'Balance reconciliation', staleAfterHours: 30, readReport: readReconcileSummary },
  { id: 'weekly-recap', label: 'Weekly recap', staleAfterHours: 8 * 24 },
  { id: 'plan-month', label: 'Month plan', staleAfterHours: 33 * 24 },
  // Every morning at 09:20 Lagos (08:20 UTC, after the audit).
  { id: 'remind', label: 'Morning reminder', staleAfterHours: 30 },
  // Sundays, to a private repository of the owner's (scripts/backup.mjs).
  // Records ok=false, on purpose, until that repository and its token are
  // set up; read here as a setup step (amber), not a failure.
  { id: 'backup', label: 'Weekly backup', staleAfterHours: 8 * 24, readReport: readBackupSummary },
]

export function hoursBetween(from, to) {
  return (new Date(to) - new Date(from)) / 3_600_000
}

/** How many days back emptyAuditRun looks for what a normal morning records. */
export const AUDIT_BASELINE_DAYS = 14

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * An audit run that recorded nothing on a mailbox that normally has alerts
 * every day. record_sync_run stores whatever ok the Routine passes, and the
 * 11 Oct run recorded "0 recorded, 0 skipped: no alerts found" as ok while
 * the reconciliation later found gaps on that day. The number is in the
 * summary already; this reads it back.
 *
 * @param {Array<{job: string, finished_at: string, ok: boolean, summary?: string|null}>} rows - any job; filtered here
 * @param {Date|string|number} [now]
 * @param {{days?: number}} [options]
 * @returns {{suspect: boolean, recorded: number|null, typical: number|null}}
 */
export function emptyAuditRun(rows = [], now = new Date(), { days = AUDIT_BASELINE_DAYS } = {}) {
  const none = { suspect: false, recorded: null, typical: null }
  const runs = (rows || [])
    .filter((r) => r && r.job === 'claude-audit' && r.ok && r.finished_at && hoursBetween(r.finished_at, now) <= days * 24)
    .sort((a, b) => new Date(b.finished_at) - new Date(a.finished_at))
  if (runs.length < 3) return none
  const latest = recordedCount(runs[0].summary)
  if (latest == null) return none
  const prior = runs
    .slice(1)
    .map((r) => recordedCount(r.summary))
    .filter((n) => n != null)
  if (prior.length < 2) return { ...none, recorded: latest }
  const typical = median(prior)
  return { suspect: latest === 0 && typical >= 1, recorded: latest, typical }
}

/**
 * One status per job from whatever sync_runs rows are on hand. Rows may
 * arrive in any order; the latest finished_at decides.
 *
 * A not-ok latest row is FAILING unless the job's `readReport` can read it
 * as a report about the data (reconcile, backup, a partial audit): then it
 * is ATTENTION, or FAILING when the report names a drift. A row too old for
 * the job's patience is STALE whatever it says: a reconcile that stopped
 * running must not keep reading "needs a look".
 *
 * @param {Array<{job: string, finished_at: string, ok: boolean, summary?: string|null}>} rows
 * @param {Date|string|number} [now]
 * @param {typeof JOBS} [jobs]
 * @returns {Array<{id: string, label: string, status: string, lastRun: object|null, lastOk: object|null, lastFailure: object|null, report: object|null, reason: string|null, suspect: boolean, suspectReason: string|null}>}
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
    let report = null
    let reason = null
    if (lastRun) {
      const stale = hoursBetween(lastRun.finished_at, now) > job.staleAfterHours
      report = !lastRun.ok && typeof job.readReport === 'function' ? job.readReport(lastRun.summary) : null
      if (report) {
        reason = [...report.drifts, ...report.gaps, ...report.other].join('; ') || null
        status = stale ? STATUS.STALE : report.drifts.length > 0 ? STATUS.FAILING : STATUS.ATTENTION
      } else if (!lastRun.ok) status = STATUS.FAILING
      else if (stale) status = STATUS.STALE
      else status = STATUS.OK
    }

    let suspect = false
    let suspectReason = null
    if (job.id === 'claude-audit' && status === STATUS.OK) {
      const quiet = emptyAuditRun(runs, now)
      if (quiet.suspect) {
        suspect = true
        suspectReason = `recorded nothing (usually ${quiet.typical} a day): check the Gmail connector`
      }
    }

    return { id: job.id, label: job.label, status, lastRun, lastOk, lastFailure, report, reason, suspect, suspectReason }
  })
}

/**
 * The jobs worth waking someone for: broken, stopped, or an audit that ran
 * and recorded nothing on a busy mailbox. A job that has never run is a
 * Settings fact, not a morning alarm, and ATTENTION is a line on the page,
 * not a reason to fail a workflow.
 */
export function unwellJobs(jobs) {
  return (jobs || []).filter((j) => j && (j.status === STATUS.FAILING || j.status === STATUS.STALE || j.suspect === true))
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
  if (jobStatuses.some((j) => j.status === STATUS.FAILING || j.suspect)) return STATUS.FAILING
  if (jobStatuses.some((j) => j.status === STATUS.STALE)) return STATUS.STALE
  if (jobStatuses.some((j) => j.status === STATUS.ATTENTION)) return STATUS.ATTENTION
  if (jobStatuses.length > 0 && jobStatuses.every((j) => j.status === STATUS.NEVER)) return STATUS.NEVER
  return STATUS.OK
}

// ───────────────────────────────────────────────────────────────
// Per-wallet coverage: has each bank been heard from?
// ───────────────────────────────────────────────────────────────

/**
 * How many days a wallet's sender may stay silent before it is worth a
 * line. A bank or mobile wallet mails most days; a savings or investment
 * account mails on interest or a deposit, about monthly.
 */
export const WALLET_QUIET_DAYS = { default: 7, savings: 35, investment: 35 }

function quietAfterDays(wallet) {
  return WALLET_QUIET_DAYS[wallet?.type] ?? WALLET_QUIET_DAYS.default
}

/**
 * Whether a wallet's bank has been heard from lately. `balance_as_of` is
 * stamped by the ingest function from the alert that last moved the balance
 * (013 baseline column; written since 001), so no query is needed beyond
 * the wallet row itself.
 *
 * @param {{type?: string, is_active?: boolean, alert_sender?: string|null, balance_as_of?: string|null, created_at?: string|null}} wallet
 * @param {Date|string|number} [now]
 * @returns {{status: 'n/a'|'never'|'ok'|'quiet', lastAlertAt: string|null, daysSince: number|null, quietAfterDays: number}}
 */
export function walletAlertStatus(wallet, now = new Date()) {
  const patience = quietAfterDays(wallet)
  if (!wallet || wallet.is_active === false || !wallet.alert_sender) {
    return { status: 'n/a', lastAlertAt: null, daysSince: null, quietAfterDays: patience }
  }
  const lastAlertAt = wallet.balance_as_of || null
  if (!lastAlertAt) return { status: 'never', lastAlertAt: null, daysSince: null, quietAfterDays: patience }
  const daysSince = Math.max(0, Math.floor(hoursBetween(lastAlertAt, now) / 24))
  return { status: daysSince > patience ? 'quiet' : 'ok', lastAlertAt, daysSince, quietAfterDays: patience }
}

/**
 * Active wallets with a sender that have gone quiet, plus the ones never
 * heard from whose row is older than the same patience (a wallet made
 * yesterday is not an alarm; Stanbic with no alert ever is).
 *
 * @param {object[]} wallets
 * @param {Date|string|number} [now]
 * @returns {Array<{wallet: object, status: 'never'|'quiet', daysSince: number|null}>}
 */
export function quietWallets(wallets, now = new Date()) {
  const out = []
  for (const wallet of wallets || []) {
    const s = walletAlertStatus(wallet, now)
    if (s.status === 'quiet') out.push({ wallet, status: 'quiet', daysSince: s.daysSince })
    else if (s.status === 'never') {
      const age = wallet.created_at ? hoursBetween(wallet.created_at, now) / 24 : Infinity
      if (age > s.quietAfterDays) out.push({ wallet, status: 'never', daysSince: null })
    }
  }
  return out
}
