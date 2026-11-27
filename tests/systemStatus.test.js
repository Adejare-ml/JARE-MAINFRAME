import { describe, it, expect } from 'vitest'
import { railState, latestRun, shortName } from '../src/lib/systemStatus.js'

const now = new Date(2026, 10, 27, 15, 0)
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 10, 27 + dayOffset, h, m).toISOString()
const run = (job, iso, ok = true, summary = null) => ({ job, finished_at: iso, ok, summary })

describe('railState', () => {
  it('shows the wordmark only when sync_runs is not migrated', () => {
    expect(railState({ available: false, loading: false, offline: false, rows: [], now }).show).toBe(false)
  })

  it('is a bare dot while loading', () => {
    const s = railState({ available: true, loading: true, offline: false, rows: [], now })
    expect(s).toMatchObject({ show: true, status: 'loading', text: '' })
  })

  it('times a healthy rail by the ledger audit', () => {
    const s = railState({ available: true, loading: false, offline: false, rows: [run('claude-audit', at(9, 14))], now })
    expect(s.status).toBe('ok')
    expect(s.text).toBe('Ledger 09:14')
  })

  it('says how stale a job is, by its short name', () => {
    const s = railState({ available: true, loading: false, offline: false, rows: [run('claude-audit', at(9, 0, -2))], now })
    expect(s.status).toBe('stale')
    expect(s.text).toBe('Ledger stale 2d')
  })

  it('names a failing audit plainly', () => {
    const s = railState({ available: true, loading: false, offline: false, rows: [run('claude-audit', at(9), false, 'boom')], now })
    expect(s.status).toBe('failing')
    expect(s.text).toBe('Audit failing')
  })

  it('counts items to review for jobs that ran and found something', () => {
    const rows = [
      run('claude-audit', at(9)),
      run('backup', at(8), false, 'not configured: no backup repository yet'),
    ]
    const s = railState({ available: true, loading: false, offline: false, rows, now })
    expect(s).toMatchObject({ status: 'attention', text: '1 item to review' })
  })

  it('says No runs yet when nothing has ever run', () => {
    const s = railState({ available: true, loading: false, offline: false, rows: [], now })
    expect(s).toMatchObject({ status: 'never', text: 'No runs yet' })
  })

  it('reports offline with the last time it heard anything', () => {
    const s = railState({ available: true, loading: false, offline: true, rows: [run('claude-audit', at(9, 14))], now })
    expect(s).toMatchObject({ status: 'offline', text: 'Offline, last 09:14' })
  })

  it('never says "live" and never carries money', () => {
    const s = railState({ available: true, loading: false, offline: false, rows: [run('claude-audit', at(9, 14))], now })
    expect(s.text).not.toMatch(/live|₦/i)
  })
})

describe('helpers', () => {
  it('latestRun picks the newest finished_at', () => {
    expect(latestRun([run('a', at(8)), run('b', at(10)), run('c', at(9))])).toBe(at(10))
    expect(latestRun([])).toBeNull()
  })

  it('shortName falls back to the label', () => {
    expect(shortName({ id: 'claude-audit' })).toBe('Ledger')
    expect(shortName({ id: 'x', label: 'Something' })).toBe('Something')
  })
})
