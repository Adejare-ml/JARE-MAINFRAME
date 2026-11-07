import { describe, it, expect } from 'vitest'
import {
  JOBS,
  STATUS,
  summarizeRuns,
  gmailCursorStatus,
  overallStatus,
  hoursBetween,
  readReconcileSummary,
  readBackupSummary,
  readAuditSummary,
  recordedCount,
  emptyAuditRun,
  unwellJobs,
  walletAlertStatus,
  quietWallets,
} from '../src/lib/health.js'

// The exact strings 040_reconcile_balances.sql formats (lines 97, 126, 135,
// 143). The parser keys on them; a migration that changes them must change
// this fixture, and the parser, together.
const RECONCILE_AGREE = '6 wallet(s) checked, ledger and bank alerts agree'
const RECONCILE_GAPS = '6 wallet(s) checked; OPay: 3 missed alert(s) around 2026-10-02, 2026-10-05; GTBank: 1 missed alert(s) around 2026-10-11'
const RECONCILE_DRIFT =
  '6 wallet(s) checked; OPay off by -3200.00 (ledger 15200.00, bank 18400.00 as of 2026-10-18); GTBank: 1 missed alert(s) around 2026-10-11'
// docs/routine-prompt.md step 3.
const AUDIT_BUSY = '14 mails found (9 debit, 5 credit) for 2026-10-17 to 2026-10-18; 9 recorded, 4 already there, 1 skipped: stanbic statement'
const AUDIT_EMPTY = '0 mails found (0 debit, 0 credit) for 2026-10-11 to 2026-10-11; 0 recorded, 0 already there, 0 skipped'

const NOW = new Date('2026-09-22T12:00:00Z')
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

describe('summarizeRuns', () => {
  it('reports every job even with no rows at all -- "never" is an answer, not an absence', () => {
    const out = summarizeRuns([], NOW)
    expect(out.map((j) => j.id)).toEqual(JOBS.map((j) => j.id))
    expect(out.every((j) => j.status === STATUS.NEVER && j.lastRun === null)).toBe(true)
  })

  it('reads a recent successful run as ok', () => {
    const [audit] = summarizeRuns([{ job: 'claude-audit', finished_at: hoursAgo(3), ok: true }], NOW)
    expect(audit.status).toBe(STATUS.OK)
    expect(audit.lastOk.finished_at).toBe(hoursAgo(3))
  })

  it('turns a success that is older than the job allows into stale', () => {
    // The audit runs once a day; 30 hours is the patience, so 31 is stale.
    expect(summarizeRuns([{ job: 'claude-audit', finished_at: hoursAgo(29), ok: true }], NOW)[0].status).toBe(STATUS.OK)
    expect(summarizeRuns([{ job: 'claude-audit', finished_at: hoursAgo(31), ok: true }], NOW)[0].status).toBe(STATUS.STALE)
  })

  it('waits eight days for the weekly backup before calling it stale', () => {
    expect(summarizeRuns([{ job: 'backup', finished_at: hoursAgo(7 * 24), ok: true }], NOW).find((j) => j.id === 'backup').status).toBe(STATUS.OK)
    expect(summarizeRuns([{ job: 'backup', finished_at: hoursAgo(9 * 24), ok: true }], NOW).find((j) => j.id === 'backup').status).toBe(STATUS.STALE)
  })

  it('gives each job its own patience -- a week-old weekly recap is fine, a week-old audit is not', () => {
    const rows = [
      { job: 'weekly-recap', finished_at: hoursAgo(6 * 24), ok: true },
      { job: 'claude-audit', finished_at: hoursAgo(6 * 24), ok: true },
    ]
    const byId = Object.fromEntries(summarizeRuns(rows, NOW).map((j) => [j.id, j.status]))
    expect(byId['weekly-recap']).toBe(STATUS.OK)
    expect(byId['claude-audit']).toBe(STATUS.STALE)
  })

  it('reads a failed latest run as failing, however recent the success before it', () => {
    const rows = [
      { job: 'snapshot-net-worth', finished_at: hoursAgo(2), ok: true },
      { job: 'snapshot-net-worth', finished_at: hoursAgo(1), ok: false, summary: 'invalid_grant' },
    ]
    const job = summarizeRuns(rows, NOW).find((j) => j.id === 'snapshot-net-worth')
    expect(job.status).toBe(STATUS.FAILING)
    expect(job.lastFailure.summary).toBe('invalid_grant')
    expect(job.lastOk.finished_at).toBe(hoursAgo(2))
  })

  it('lets the newest finished_at decide regardless of row order', () => {
    const rows = [
      { job: 'verify-repo', finished_at: hoursAgo(1), ok: true },
      { job: 'verify-repo', finished_at: hoursAgo(5), ok: false },
    ]
    expect(summarizeRuns(rows, NOW).find((j) => j.id === 'verify-repo').status).toBe(STATUS.OK)
    expect(summarizeRuns(rows.reverse(), NOW).find((j) => j.id === 'verify-repo').status).toBe(STATUS.OK)
  })

  it('ignores rows for jobs it does not know and malformed rows', () => {
    const rows = [{ job: 'someone-elses-cron', finished_at: hoursAgo(1), ok: true }, null, { finished_at: hoursAgo(1) }]
    expect(() => summarizeRuns(rows, NOW)).not.toThrow()
    expect(summarizeRuns(rows, NOW).every((j) => j.status === STATUS.NEVER)).toBe(true)
  })

  const find = (rows, id) => summarizeRuns(rows, NOW).find((j) => j.id === id)

  it('reads a reconcile run that found missed alerts as attention, not failing', () => {
    const job = find([{ job: 'reconcile', finished_at: hoursAgo(2), ok: false, summary: RECONCILE_GAPS }], 'reconcile')
    expect(job.status).toBe(STATUS.ATTENTION)
    expect(job.report.gaps).toHaveLength(2)
    expect(job.report.drifts).toHaveLength(0)
    expect(job.reason).toContain('OPay: 3 missed alert(s)')
  })

  it('keeps a reconcile drift red, with the drift first in the reason', () => {
    const job = find([{ job: 'reconcile', finished_at: hoursAgo(2), ok: false, summary: RECONCILE_DRIFT }], 'reconcile')
    expect(job.status).toBe(STATUS.FAILING)
    expect(job.report.drifts[0]).toMatch(/^OPay off by -3200.00/)
    expect(job.reason.startsWith('OPay off by')).toBe(true)
  })

  it('reads a reconcile crash as plain failing, and an agreeing run as ok', () => {
    expect(find([{ job: 'reconcile', finished_at: hoursAgo(2), ok: false, summary: 'division by zero' }], 'reconcile').status).toBe(STATUS.FAILING)
    const ok = find([{ job: 'reconcile', finished_at: hoursAgo(2), ok: true, summary: RECONCILE_AGREE }], 'reconcile')
    expect(ok.status).toBe(STATUS.OK)
    expect(ok.report).toBeNull()
  })

  it('lets stale win over a report: a reconcile that stopped running is not "needs a look"', () => {
    expect(find([{ job: 'reconcile', finished_at: hoursAgo(40), ok: false, summary: RECONCILE_GAPS }], 'reconcile').status).toBe(STATUS.STALE)
  })

  it('reads the unconfigured backup as a setup step, not a failing job', () => {
    const summary = 'not configured: BACKUP_REPO / BACKUP_REPO_TOKEN are not set. Create a private repository …'
    const job = find([{ job: 'backup', finished_at: hoursAgo(24), ok: false, summary }], 'backup')
    expect(job.status).toBe(STATUS.ATTENTION)
    expect(job.report.setup).toBe(true)
    expect(find([{ job: 'backup', finished_at: hoursAgo(24), ok: false, summary: 'GitHub 401 writing latest.json' }], 'backup').status).toBe(STATUS.FAILING)
  })

  it('reads an audit that read the mailbox but skipped one alert as attention', () => {
    const job = find([{ job: 'claude-audit', finished_at: hoursAgo(2), ok: false, summary: AUDIT_BUSY }], 'claude-audit')
    expect(job.status).toBe(STATUS.ATTENTION)
    expect(job.reason).toBe('1 skipped: stanbic statement')
    // Nothing recorded and nothing found: the search failed, which is red.
    expect(find([{ job: 'claude-audit', finished_at: hoursAgo(2), ok: false, summary: AUDIT_EMPTY }], 'claude-audit').status).toBe(STATUS.FAILING)
    expect(find([{ job: 'claude-audit', finished_at: hoursAgo(2), ok: false, summary: 'permission denied for function' }], 'claude-audit').status).toBe(STATUS.FAILING)
  })

  it('flags an ok audit that recorded nothing on a busy mailbox as suspect', () => {
    const rows = [1, 2, 3, 4, 5].map((d) => ({ job: 'claude-audit', finished_at: hoursAgo(d * 24 + 1), ok: true, summary: AUDIT_BUSY }))
    rows.push({ job: 'claude-audit', finished_at: hoursAgo(1), ok: true, summary: AUDIT_EMPTY })
    const job = find(rows, 'claude-audit')
    expect(job.status).toBe(STATUS.OK)
    expect(job.suspect).toBe(true)
    expect(job.suspectReason).toContain('usually 9 a day')
    expect(unwellJobs(summarizeRuns(rows, NOW)).map((j) => j.id)).toEqual(['claude-audit'])
    expect(overallStatus(summarizeRuns(rows, NOW))).toBe(STATUS.FAILING)
  })
})

describe('readReconcileSummary', () => {
  it('splits drifts from gaps and reads the agree suffix', () => {
    expect(readReconcileSummary(RECONCILE_AGREE)).toEqual({ drifts: [], gaps: [], other: [], agree: true })
    expect(readReconcileSummary(RECONCILE_DRIFT).drifts).toHaveLength(1)
    expect(readReconcileSummary(RECONCILE_DRIFT).gaps).toEqual(['GTBank: 1 missed alert(s) around 2026-10-11'])
  })

  it('tolerates a segment cut by the 500-character cap and rejects foreign text', () => {
    expect(readReconcileSummary('6 wallet(s) checked; OPay: 3 missed al').gaps).toHaveLength(1)
    expect(readReconcileSummary('invalid_grant')).toBeNull()
    expect(readReconcileSummary(null)).toBeNull()
  })
})

describe('readBackupSummary', () => {
  it('recognises only the not-configured message', () => {
    expect(readBackupSummary('not configured: BACKUP_REPO is not set').setup).toBe(true)
    expect(readBackupSummary('3412 rows across 18 tables')).toBeNull()
  })
})

describe('readAuditSummary / recordedCount', () => {
  it('reads the four counts the Routine records', () => {
    expect(readAuditSummary(AUDIT_BUSY)).toEqual({ found: 14, recorded: 9, already: 4, skipped: 1 })
    expect(recordedCount('0 recorded, 0 skipped: no alerts found')).toBe(0)
    expect(recordedCount('invalid_grant')).toBeNull()
    expect(readAuditSummary(null).found).toBeNull()
  })
})

describe('emptyAuditRun', () => {
  const run = (daysAgo, summary, ok = true) => ({ job: 'claude-audit', finished_at: hoursAgo(daysAgo * 24 + 1), ok, summary })

  it('is suspect when the newest run recorded 0 and the prior median is at least 1', () => {
    const rows = [run(0, AUDIT_EMPTY), run(1, AUDIT_BUSY), run(2, AUDIT_BUSY), run(3, '3 recorded, 0 already there')]
    expect(emptyAuditRun(rows, NOW)).toEqual({ suspect: true, recorded: 0, typical: 9 })
  })

  it('is quiet on a genuinely quiet fortnight, with too few rows, or a failed latest row', () => {
    expect(emptyAuditRun([run(0, AUDIT_EMPTY), run(1, AUDIT_EMPTY), run(2, AUDIT_EMPTY)], NOW).suspect).toBe(false)
    expect(emptyAuditRun([run(0, AUDIT_EMPTY), run(1, AUDIT_BUSY)], NOW).suspect).toBe(false)
    expect(emptyAuditRun([run(0, AUDIT_EMPTY, false), run(1, AUDIT_BUSY), run(2, AUDIT_BUSY)], NOW).suspect).toBe(false)
    // Rows older than the window are not a baseline.
    expect(emptyAuditRun([run(0, AUDIT_EMPTY), run(20, AUDIT_BUSY), run(21, AUDIT_BUSY)], NOW).suspect).toBe(false)
  })
})

describe('unwellJobs', () => {
  it('keeps failing, stale and suspect; drops ok, never and attention', () => {
    const jobs = [
      { id: 'a', status: STATUS.FAILING },
      { id: 'b', status: STATUS.STALE },
      { id: 'c', status: STATUS.OK, suspect: true },
      { id: 'd', status: STATUS.OK },
      { id: 'e', status: STATUS.NEVER },
      { id: 'f', status: STATUS.ATTENTION },
      null,
    ]
    expect(unwellJobs(jobs).map((j) => j.id)).toEqual(['a', 'b', 'c'])
    expect(unwellJobs(undefined)).toEqual([])
  })
})

describe('walletAlertStatus / quietWallets', () => {
  const daysAgoIso = (d) => hoursAgo(d * 24).slice(0, 19)
  const bank = (over) => ({ name: 'GTBank', type: 'bank', is_active: true, alert_sender: 'gens@gtbank.com', created_at: hoursAgo(90 * 24), ...over })

  it('is ok within a week for a bank and quiet past it; savings get five weeks', () => {
    expect(walletAlertStatus(bank({ balance_as_of: daysAgoIso(3) }), NOW)).toMatchObject({ status: 'ok', daysSince: 3 })
    expect(walletAlertStatus(bank({ balance_as_of: daysAgoIso(8) }), NOW).status).toBe('quiet')
    expect(walletAlertStatus(bank({ type: 'savings', balance_as_of: daysAgoIso(8) }), NOW).status).toBe('ok')
    expect(walletAlertStatus(bank({ type: 'savings', balance_as_of: daysAgoIso(36) }), NOW).status).toBe('quiet')
  })

  it('is n/a without a sender or when inactive, and never without a stamp', () => {
    expect(walletAlertStatus(bank({ alert_sender: null, balance_as_of: null }), NOW).status).toBe('n/a')
    expect(walletAlertStatus(bank({ is_active: false, balance_as_of: daysAgoIso(1) }), NOW).status).toBe('n/a')
    expect(walletAlertStatus(bank({ balance_as_of: null }), NOW).status).toBe('never')
  })

  it('lists quiet wallets and never-heard wallets older than the patience', () => {
    const wallets = [
      bank({ name: 'Fresh', balance_as_of: null, created_at: hoursAgo(2 * 24) }),
      bank({ name: 'Stanbic', balance_as_of: null, created_at: hoursAgo(30 * 24) }),
      bank({ name: 'OPay', balance_as_of: daysAgoIso(1) }),
      bank({ name: 'Zenith', balance_as_of: daysAgoIso(12) }),
      bank({ name: 'Cash', alert_sender: null }),
    ]
    expect(quietWallets(wallets, NOW).map((q) => [q.wallet.name, q.status])).toEqual([
      ['Stanbic', 'never'],
      ['Zenith', 'quiet'],
    ])
  })
})

describe('gmailCursorStatus', () => {
  it('is never before the first check', () => {
    expect(gmailCursorStatus(null, NOW).status).toBe(STATUS.NEVER)
    expect(gmailCursorStatus({ last_checked: null }, NOW).status).toBe(STATUS.NEVER)
  })

  it('is ok within the daily audit\'s window, and stale past it', () => {
    expect(gmailCursorStatus({ last_checked: hoursAgo(29), last_sync: '2026-09-22' }, NOW)).toMatchObject({
      status: STATUS.OK,
      caughtUpTo: '2026-09-22',
    })
    expect(gmailCursorStatus({ last_checked: hoursAgo(31) }, NOW).status).toBe(STATUS.STALE)
  })
})

describe('overallStatus', () => {
  const j = (status) => ({ status })

  it('lets the worst job win, failing before stale before attention', () => {
    expect(overallStatus([j(STATUS.OK), j(STATUS.STALE), j(STATUS.FAILING)])).toBe(STATUS.FAILING)
    expect(overallStatus([j(STATUS.OK), j(STATUS.STALE)])).toBe(STATUS.STALE)
    expect(overallStatus([j(STATUS.OK), j(STATUS.ATTENTION), j(STATUS.STALE)])).toBe(STATUS.STALE)
    expect(overallStatus([j(STATUS.OK), j(STATUS.ATTENTION)])).toBe(STATUS.ATTENTION)
    expect(overallStatus([j(STATUS.OK), j(STATUS.NEVER)])).toBe(STATUS.OK)
  })

  it('is never only when nothing has ever run', () => {
    expect(overallStatus([j(STATUS.NEVER), j(STATUS.NEVER)])).toBe(STATUS.NEVER)
    expect(overallStatus([])).toBe(STATUS.OK)
  })
})

describe('hoursBetween', () => {
  it('measures forward in hours from ISO strings or dates', () => {
    expect(hoursBetween(hoursAgo(3), NOW)).toBeCloseTo(3, 6)
  })
})
