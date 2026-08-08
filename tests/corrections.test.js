import { describe, it, expect } from 'vitest'
import {
  validateCorrection,
  isMissingFunctionError,
  signedEffect,
  balanceDelta,
} from '../src/lib/corrections.js'

describe('validateCorrection', () => {
  const good = { type: 'debit', amount: '1200.50', date: '2026-08-08' }

  it('accepts a well-formed correction and returns a number', () => {
    const result = validateCorrection(good)
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ type: 'debit', amount: 1200.5, date: '2026-08-08' })
  })

  it('rejects a direction that is neither debit nor credit', () => {
    // The UI can only produce two values, but the RPC is reachable by anything
    // holding the anon key, and 'DEBIT' would be silently stored and then
    // counted as neither income nor spending by summarizeMonth.
    for (const type of ['DEBIT', 'transfer', '', null, undefined]) {
      expect(validateCorrection({ ...good, type }).ok).toBe(false)
    }
  })

  it('rejects an empty or whitespace amount', () => {
    // Number('') and Number('  ') are both 0, so a bare `Number(x) > 0` on the
    // raw string is not enough -- clearing the box would post a zero.
    for (const amount of ['', '   ', null, undefined]) {
      const result = validateCorrection({ ...good, amount })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/greater than zero/)
    }
  })

  it('rejects zero, negative and non-numeric amounts', () => {
    for (const amount of ['0', '-500', 'abc', '1,200', Infinity, NaN]) {
      expect(validateCorrection({ ...good, amount }).ok).toBe(false)
    }
  })

  it('rounds to kobo rather than storing float noise', () => {
    expect(validateCorrection({ ...good, amount: 1200.9999999999998 }).value.amount).toBe(1201)
    expect(validateCorrection({ ...good, amount: '10.005' }).value.amount).toBe(10.01)
  })

  it('rejects a malformed date', () => {
    for (const date of ['08/08/2026', '2026-8-8', '2026-08-08T00:00:00Z', '', null]) {
      expect(validateCorrection({ ...good, date }).ok).toBe(false)
    }
  })

  it('rejects a date that does not exist', () => {
    // JS Date rolls 2026-02-31 forward to 3 March without complaint, so the
    // row would silently land in the wrong month -- and month totals are keyed
    // on transaction_date.
    expect(validateCorrection({ ...good, date: '2026-02-31' }).ok).toBe(false)
    expect(validateCorrection({ ...good, date: '2026-13-01' }).ok).toBe(false)
    expect(validateCorrection({ ...good, date: '2026-02-29' }).ok).toBe(false)
    // 2028 is a leap year; the same date must be accepted there.
    expect(validateCorrection({ ...good, date: '2028-02-29' }).ok).toBe(true)
  })
})

describe('isMissingFunctionError', () => {
  it('recognises PostgREST and Postgres missing-function codes', () => {
    expect(isMissingFunctionError({ code: 'PGRST202' })).toBe(true)
    expect(isMissingFunctionError({ code: '42883' })).toBe(true)
    expect(
      isMissingFunctionError({
        message: 'Could not find the function public.correct_transaction in the schema cache',
      }),
    ).toBe(true)
  })

  it('does not swallow real failures', () => {
    // This is the one that matters: if a permission error or a check-constraint
    // violation were treated as "function missing", the fallback would run and
    // the user would be told the edit saved when it did not.
    expect(isMissingFunctionError({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isMissingFunctionError({ code: '23514', message: 'violates check constraint' })).toBe(false)
    expect(isMissingFunctionError({ message: 'Failed to fetch' })).toBe(false)
    expect(isMissingFunctionError(null)).toBe(false)
  })
})

describe('balance arithmetic', () => {
  // Mirrors the CASE expressions in migration 007. Kept in sync by hand, so
  // these assertions are the record of what the RPC is supposed to compute.
  it('treats a voided row as contributing nothing', () => {
    expect(signedEffect({ type: 'debit', amount: 500, voided: true })).toBe(0)
    expect(signedEffect({ type: 'credit', amount: 500, voided: true })).toBe(0)
  })

  it('signs debits negative and credits positive', () => {
    expect(signedEffect({ type: 'debit', amount: 500 })).toBe(-500)
    expect(signedEffect({ type: 'credit', amount: 500 })).toBe(500)
  })

  it('refunds the full amount on void', () => {
    const before = { type: 'debit', amount: 250 }
    expect(balanceDelta(before, { ...before, voided: true })).toBe(250)
  })

  it('is a no-op when a voided row is voided again', () => {
    // Otherwise a double-tap would credit the wallet twice for one mistake.
    const voided = { type: 'debit', amount: 250, voided: true }
    expect(balanceDelta(voided, { ...voided })).toBe(0)
  })

  it('moves only the difference when an amount is corrected', () => {
    expect(balanceDelta({ type: 'debit', amount: 5000 }, { type: 'debit', amount: 500 })).toBe(4500)
  })

  it('moves twice the amount when a direction is flipped', () => {
    // A ₦20,000 credit mis-read as a debit is ₦40,000 out of position, which is
    // exactly the case that made this whole feature necessary.
    expect(balanceDelta({ type: 'debit', amount: 20000 }, { type: 'credit', amount: 20000 })).toBe(40000)
  })
})
