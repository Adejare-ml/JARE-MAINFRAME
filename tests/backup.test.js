import { describe, it, expect } from 'vitest'
import { isSafeBackupTarget, unsafeTargetReason, contentsHeaders, assertBundleHasLedger, runRecordFor } from '../src/lib/backup.js'

describe('isSafeBackupTarget', () => {
  it('accepts only a private repository that is not this one', () => {
    expect(isSafeBackupTarget({ private: true, full_name: 'me/jare-backups' }, 'Adejare-ml/JARE-MAINFRAME')).toBe(true)
    expect(isSafeBackupTarget({ private: false, full_name: 'me/jare-backups' }, 'Adejare-ml/JARE-MAINFRAME')).toBe(false)
    expect(isSafeBackupTarget({ private: true, full_name: 'adejare-ml/jare-mainframe' }, 'Adejare-ml/JARE-MAINFRAME')).toBe(false)
    expect(isSafeBackupTarget({ full_name: 'me/jare-backups' }, '')).toBe(false)
    expect(isSafeBackupTarget(null, '')).toBe(false)
  })

  it('says why, without the figure-of-speech', () => {
    expect(unsafeTargetReason({ private: false, full_name: 'me/jare-backups' })).toMatch(/is public/)
    expect(unsafeTargetReason(null)).toMatch(/could not be read/)
  })
})

describe('contentsHeaders', () => {
  it('asks for the object media type on a lookup so a blob over 1 MB still answers', () => {
    expect(contentsHeaders('t', { purpose: 'lookup' }).accept).toBe('application/vnd.github.object+json')
    expect(contentsHeaders('t').accept).toBe('application/vnd.github+json')
    expect(contentsHeaders('t').authorization).toBe('Bearer t')
  })
})

describe('assertBundleHasLedger', () => {
  it('passes with a ledger and throws with the skip reason without one', () => {
    expect(() => assertBundleHasLedger({ tables: { transactions: [] } })).not.toThrow()
    expect(() => assertBundleHasLedger({ tables: {}, skipped: [{ table: 'transactions', reason: 'statement timeout' }] })).toThrow(
      /statement timeout; nothing was written/,
    )
    expect(() => assertBundleHasLedger(null)).toThrow(/unknown/)
  })
})

describe('runRecordFor', () => {
  it('never records a dry run as ok', () => {
    expect(runRecordFor({ dryRun: true, configured: true, written: false, rowCount: 10, kb: 2 })).toEqual({
      ok: false,
      summary: 'dry run: 10 rows, 2 KB, nothing written',
    })
    expect(runRecordFor({ dryRun: true, configured: false, written: false }).summary).toMatch(/destination not configured/)
  })

  it('records an unconfigured run with the setup text health.js recognises', () => {
    const record = runRecordFor({ dryRun: false, configured: false, written: false })
    expect(record.ok).toBe(false)
    expect(record.summary).toMatch(/^not configured:/)
  })

  it('is ok only when both files were written', () => {
    expect(runRecordFor({ dryRun: false, configured: true, written: true, rowCount: 3412, tableCount: 21, kb: 2370, target: 'me/b/backups/x.json' })).toEqual({
      ok: true,
      summary: '3412 rows across 21 tables, 2370 KB → me/b/backups/x.json',
    })
    expect(runRecordFor({ dryRun: false, configured: true, written: false }).ok).toBe(false)
  })
})
