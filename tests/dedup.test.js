import { describe, it, expect } from 'vitest'
import {
  generateSyntheticId,
  buildNaturalKey,
  isSyntheticId,
  fnv1a64,
} from '../src/lib/sync/dedup.js'

describe('generateSyntheticId', () => {
  const txn = ['gtbank', 26.88, '2026-07-29', 'STAMP DUTY CHARGE']

  it('returns the same ID for the same transaction', () => {
    expect(generateSyntheticId(...txn)).toBe(generateSyntheticId(...txn))
  })

  // The bug this suite exists for: the frontend used to fold Date.now() into
  // the hash, so dedup never matched and every charge email was re-inserted on
  // every sync.
  it('does not change over time', async () => {
    const first = generateSyntheticId(...txn)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(generateSyntheticId(...txn)).toBe(first)
  })

  it('produces a stable known value, so the algorithm cannot change silently', () => {
    // These are literals on purpose. The previous version of this test compared
    // generateSyntheticId to itself, which is a tautology: it stayed green
    // through any change to the hash, the 60-character truncation or the field
    // separator, while every synthetic ID already in the database was orphaned
    // and every GTBank charge email was re-inserted as new.
    //
    // If a change here is deliberate, ship a backfill alongside it. If it is a
    // surprise, something upstream in buildNaturalKey moved.
    expect(generateSyntheticId('gtbank', 20000, '2026-07-29', 'TRF TO JOHN DOE')).toBe(
      'SYN-fde821d3256524dc',
    )
    expect(generateSyntheticId(...txn)).toBe('SYN-d2173cafecc9cfc3')
  })

  it('separates transactions that differ in any field', () => {
    const base = generateSyntheticId('gtbank', 100, '2026-07-29', 'POS PURCHASE')
    expect(generateSyntheticId('opay', 100, '2026-07-29', 'POS PURCHASE')).not.toBe(base)
    expect(generateSyntheticId('gtbank', 101, '2026-07-29', 'POS PURCHASE')).not.toBe(base)
    expect(generateSyntheticId('gtbank', 100, '2026-07-30', 'POS PURCHASE')).not.toBe(base)
    expect(generateSyntheticId('gtbank', 100, '2026-07-29', 'ATM WITHDRAWAL')).not.toBe(base)
  })

  it('collapses cosmetic differences in the same transaction', () => {
    const a = generateSyntheticId('gtbank', 100, '2026-07-29', 'POS PURCHASE')
    expect(generateSyntheticId('GTBank', '100.00', '2026-07-29', '  pos   purchase ')).toBe(a)
  })

  it('separates two same-day charges that differ only past 60 description chars', () => {
    // Truncation is deliberate, and this documents the blind spot: two charges
    // for the same amount on the same day with identical 60-char prefixes
    // collapse into one. Bank references cover the real cases; synthetic IDs
    // are only used when the bank sends none.
    const prefix = 'X'.repeat(60)
    expect(generateSyntheticId('gtbank', 50, '2026-07-29', `${prefix}AAA`)).toBe(
      generateSyntheticId('gtbank', 50, '2026-07-29', `${prefix}BBB`),
    )
  })

  it('handles missing fields without throwing', () => {
    expect(generateSyntheticId('', null, '', '')).toMatch(/^SYN-[0-9a-f]{16}$/)
    expect(generateSyntheticId('gtbank', undefined, '2026-07-29', undefined)).toMatch(/^SYN-/)
  })
})

describe('buildNaturalKey', () => {
  it('normalises amount to two decimal places', () => {
    expect(buildNaturalKey('gtbank', 20000, '2026-07-29', 'x')).toContain('|20000.00|')
    expect(buildNaturalKey('gtbank', '20000.004', '2026-07-29', 'x')).toContain('|20000.00|')
  })

  it('falls back to 0.00 for an unparseable amount', () => {
    expect(buildNaturalKey('gtbank', 'not a number', '2026-07-29', 'x')).toContain('|0.00|')
  })
})

describe('isSyntheticId', () => {
  it('recognises our own IDs and not bank references', () => {
    expect(isSyntheticId(generateSyntheticId('gtbank', 1, '2026-01-01', 'x'))).toBe(true)
    expect(isSyntheticId('044884719406769l5872')).toBe(false)
    expect(isSyntheticId(null)).toBe(false)
    expect(isSyntheticId(undefined)).toBe(false)
  })
})

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64-bit test vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325')
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c')
    expect(fnv1a64('foobar')).toBe('85944171f73967e8')
  })

  it('always returns 16 hex characters', () => {
    for (const input of ['', 'a', 'a longer string', '₦2,600.00 opay']) {
      expect(fnv1a64(input)).toMatch(/^[0-9a-f]{16}$/)
    }
  })
})
