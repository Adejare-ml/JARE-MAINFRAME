import { describe, it, expect } from 'vitest'
import { JOBS, STATUS, summarizeRuns, gmailCursorStatus, overallStatus, hoursBetween } from '../src/lib/health.js'

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
      { job: 'draft-day', finished_at: hoursAgo(2), ok: true },
      { job: 'draft-day', finished_at: hoursAgo(1), ok: false, summary: 'invalid_grant' },
    ]
    const job = summarizeRuns(rows, NOW).find((j) => j.id === 'draft-day')
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

  it('lets the worst job win, failing before stale', () => {
    expect(overallStatus([j(STATUS.OK), j(STATUS.STALE), j(STATUS.FAILING)])).toBe(STATUS.FAILING)
    expect(overallStatus([j(STATUS.OK), j(STATUS.STALE)])).toBe(STATUS.STALE)
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
