import { describe, it, expect, afterEach, vi } from 'vitest'
import { recordRun, RUN_RETENTION_DAYS } from '../scripts/lib/recordRun.mjs'

/** A stand-in for the two query shapes recordRun issues, recording both. */
function fakeClient({ insertError = null } = {}) {
  const inserts = []
  const deletes = []
  return {
    inserts,
    deletes,
    from: (table) => ({
      insert: async (row) => {
        inserts.push({ table, row })
        return { error: insertError }
      },
      delete: () => {
        const call = { table, filters: [] }
        deletes.push(call)
        const chain = {
          eq: (column, value) => {
            call.filters.push(['eq', column, value])
            return chain
          },
          lt: (column, value) => {
            call.filters.push(['lt', column, value])
            return chain
          },
          then: (resolve) => resolve({ error: null }),
        }
        return chain
      },
    }),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('recordRun', () => {
  it('writes one row with the run facts and reports success', async () => {
    const client = fakeClient()
    const startedAt = new Date('2026-09-22T06:00:00Z')
    const ok = await recordRun(client, { job: 'gmail-sync', userId: 'u1', startedAt, ok: true, summary: '3 new' })

    expect(ok).toBe(true)
    expect(client.inserts).toHaveLength(1)
    const { table, row } = client.inserts[0]
    expect(table).toBe('sync_runs')
    expect(row).toMatchObject({ user_id: 'u1', job: 'gmail-sync', ok: true, summary: '3 new' })
    expect(row.started_at).toBe(startedAt.toISOString())
    expect(new Date(row.finished_at).getTime()).toBeGreaterThanOrEqual(startedAt.getTime())
  })

  it('accepts a numeric start time, the Date.now() the sync already keeps', async () => {
    const client = fakeClient()
    await recordRun(client, { job: 'gmail-sync', userId: 'u1', startedAt: 1_700_000_000_000, ok: false })
    expect(client.inserts[0].row.started_at).toBe(new Date(1_700_000_000_000).toISOString())
    expect(client.inserts[0].row.summary).toBeNull()
  })

  it('bounds the summary so a stack trace cannot become the row', async () => {
    const client = fakeClient()
    await recordRun(client, { job: 'x', userId: 'u1', startedAt: new Date(), ok: false, summary: 'e'.repeat(2000) })
    expect(client.inserts[0].row.summary).toHaveLength(500)
  })

  it('prunes only this user, this job, older than the retention window', async () => {
    const client = fakeClient()
    const before = Date.now()
    await recordRun(client, { job: 'draft-day', userId: 'u1', startedAt: new Date(), ok: true })

    expect(client.deletes).toHaveLength(1)
    const filters = client.deletes[0].filters
    expect(filters).toContainEqual(['eq', 'user_id', 'u1'])
    expect(filters).toContainEqual(['eq', 'job', 'draft-day'])
    const lt = filters.find(([op]) => op === 'lt')
    expect(lt[1]).toBe('finished_at')
    const cutoffAge = before - new Date(lt[2]).getTime()
    expect(cutoffAge).toBeGreaterThanOrEqual(RUN_RETENTION_DAYS * 86_400_000 - 1000)
    expect(cutoffAge).toBeLessThan(RUN_RETENTION_DAYS * 86_400_000 + 60_000)
  })

  it('never throws when the write fails -- a database behind 025 costs the note, not the job', async () => {
    const warnings = []
    vi.spyOn(console, 'warn').mockImplementation((line) => warnings.push(line))
    const client = fakeClient({ insertError: { message: 'relation "sync_runs" does not exist' } })

    await expect(recordRun(client, { job: 'x', userId: 'u1', startedAt: new Date(), ok: true })).resolves.toBe(false)
    expect(client.deletes).toHaveLength(0)
    expect(warnings.join('\n')).toContain('sync_runs')
  })
})
