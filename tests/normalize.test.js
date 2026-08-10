import { describe, it, expect } from 'vitest'
import {
  validateParsedTransaction,
  extractJsonObject,
  isValidDate,
  RAW_EMAIL_MAX_CHARS,
  VALID_CONFIDENCE,
} from '../src/lib/sync/normalize.js'

const valid = {
  type: 'debit',
  amount: 2600,
  category: 'Transport',
  description: 'Bolt ride',
  transaction_date: '2026-07-30',
  transaction_time: '10:30:09',
  confidence: 'HIGH',
}

describe('confidence matches what the database will accept', () => {
  // `transactions_confidence_check` in the live schema permits HIGH and LOW.
  // This list is the last gate before an insert, so any value it blesses is a
  // value Postgres is asked to store. When it listed MEDIUM as well, a sync run
  // found 32 emails and inserted zero -- every row rejected with a 23514, under
  // a report that read "Synced 0 new transactions", which is also what a run
  // that legitimately finds nothing prints.
  it('permits exactly the two values the check constraint allows', () => {
    expect(VALID_CONFIDENCE).toEqual(['HIGH', 'LOW'])
  })

  it('coerces MEDIUM to LOW rather than passing it to the database', () => {
    const result = validateParsedTransaction({ ...valid, confidence: 'MEDIUM' })
    expect(result.ok).toBe(true)
    expect(result.value.confidence).toBe('LOW')
  })

  it.each([['HIGH'], ['LOW'], ['high'], ['low']])('keeps %s', (confidence) => {
    const result = validateParsedTransaction({ ...valid, confidence })
    expect(result.value.confidence).toBe(confidence.toUpperCase())
  })

  it('never emits a value outside the whitelist, whatever it is handed', () => {
    for (const junk of ['MAYBE', '', null, undefined, 42, 'HIGHEST']) {
      const result = validateParsedTransaction({ ...valid, confidence: junk })
      expect(VALID_CONFIDENCE).toContain(result.value.confidence)
    }
  })
})

describe('validateParsedTransaction', () => {
  it('passes a well-formed transaction through', () => {
    const result = validateParsedTransaction(valid)

    expect(result.ok).toBe(true)
    expect(result.value.type).toBe('debit')
    expect(result.value.amount).toBe(2600)
    expect(result.value.category).toBe('Transport')
    expect(result.warnings).toEqual([])
  })

  // A direction the app doesn't understand silently corrupts monthly totals,
  // so these are dropped rather than guessed at.
  it.each([
    ['transfer', 'a word the LLM invented'],
    ['DEBIT ', 'trailing whitespace is fine'],
    ['', 'empty'],
    [null, 'null'],
    [undefined, 'missing'],
  ])('handles type %j (%s)', (type) => {
    const result = validateParsedTransaction({ ...valid, type })
    if (typeof type === 'string' && ['debit', 'credit'].includes(type.trim().toLowerCase())) {
      expect(result.ok).toBe(true)
    } else {
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('invalid type')
    }
  })

  it('normalises casing and whitespace in type', () => {
    expect(validateParsedTransaction({ ...valid, type: ' CREDIT ' }).value.type).toBe('credit')
  })

  it.each([0, -50, NaN, Infinity, 'abc', null])('rejects amount %j', (amount) => {
    const result = validateParsedTransaction({ ...valid, amount })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('invalid amount')
  })

  it('rejects impossible dates', () => {
    expect(validateParsedTransaction({ ...valid, transaction_date: '2026-02-31' }).ok).toBe(false)
    expect(validateParsedTransaction({ ...valid, transaction_date: '30/07/2026' }).ok).toBe(false)
    expect(validateParsedTransaction({ ...valid, transaction_date: null }).ok).toBe(false)
  })

  // Recoverable, so it is downgraded rather than dropped: an unknown category
  // would break every filter and rollup, but the amount and direction are still
  // worth keeping.
  it('falls back to Uncategorized + LOW for a category the app does not know', () => {
    const result = validateParsedTransaction({ ...valid, category: 'Crypto Gambling' })

    expect(result.ok).toBe(true)
    expect(result.value.category).toBe('Uncategorized')
    expect(result.value.confidence).toBe('LOW')
    expect(result.warnings[0]).toContain('unknown category')
  })

  it('defaults a malformed time rather than dropping the record', () => {
    const result = validateParsedTransaction({ ...valid, transaction_time: '10:30 AM' })

    expect(result.ok).toBe(true)
    expect(result.value.transaction_time).toBe('12:00:00')
    expect(result.warnings[0]).toContain('transaction_time')
  })

  it('drops an unusable available_balance but keeps the transaction', () => {
    const result = validateParsedTransaction({ ...valid, available_balance: 'unknown' })

    expect(result.ok).toBe(true)
    expect(result.value.available_balance).toBeNull()
  })

  it('keeps a real available_balance, including zero', () => {
    expect(validateParsedTransaction({ ...valid, available_balance: 0 }).value.available_balance).toBe(0)
    expect(validateParsedTransaction({ ...valid, available_balance: '5808.09' }).value.available_balance).toBe(5808.09)
  })

  it('truncates raw_email so full bank bodies do not reach the database', () => {
    const result = validateParsedTransaction({ ...valid, raw_email: 'x'.repeat(5000) })
    expect(result.value.raw_email).toHaveLength(RAW_EMAIL_MAX_CHARS)
  })

  it('coerces an unrecognised confidence to LOW', () => {
    expect(validateParsedTransaction({ ...valid, confidence: 'VERY SURE' }).value.confidence).toBe('LOW')
  })

  it('rejects non-objects', () => {
    expect(validateParsedTransaction(null).ok).toBe(false)
    expect(validateParsedTransaction('a string').ok).toBe(false)
  })
})

describe('isValidDate', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isValidDate('2026-07-30')).toBe(true)
    expect(isValidDate('2024-02-29')).toBe(true)
    expect(isValidDate('2026-02-29')).toBe(false)
    expect(isValidDate('2026-13-01')).toBe(false)
    expect(isValidDate('26-07-30')).toBe(false)
    expect(isValidDate('')).toBe(false)
  })
})

describe('extractJsonObject', () => {
  it('reads a bare JSON object', () => {
    expect(extractJsonObject('{"type":"debit","amount":100}')).toEqual({ type: 'debit', amount: 100 })
  })

  // The reason this function exists. A reasoning model wraps its answer in a
  // <think> block, and the old greedy first-brace-to-last-brace match grabbed
  // the braces inside the reasoning instead.
  it('reads past a reasoning block', () => {
    const content = `<think>
The email says {amount: 2600} but I should check the direction first.
Looking at { this } and { that }.
</think>
{"type":"debit","amount":2600}`
    expect(extractJsonObject(content)).toEqual({ type: 'debit', amount: 2600 })
  })

  it('reads past an unterminated reasoning block', () => {
    expect(extractJsonObject('Some reasoning {maybe} here</think>{"type":"credit","amount":5}')).toEqual({
      type: 'credit',
      amount: 5,
    })
  })

  it('reads out of a markdown code fence', () => {
    expect(extractJsonObject('```json\n{"type":"credit","amount":150}\n```')).toEqual({
      type: 'credit',
      amount: 150,
    })
    expect(extractJsonObject('Here you go:\n```\n{"amount":1}\n```\nHope that helps!')).toEqual({ amount: 1 })
  })

  it('keeps nested objects intact', () => {
    expect(extractJsonObject('{"a":{"b":{"c":1}},"d":2}')).toEqual({ a: { b: { c: 1 } }, d: 2 })
  })

  it('is not confused by braces inside string values', () => {
    expect(extractJsonObject('{"description":"PAYMENT {REF} TO }X{","amount":5}')).toEqual({
      description: 'PAYMENT {REF} TO }X{',
      amount: 5,
    })
  })

  it('is not confused by escaped quotes', () => {
    expect(extractJsonObject('{"description":"SAID \\"HELLO\\" }","amount":5}')).toEqual({
      description: 'SAID "HELLO" }',
      amount: 5,
    })
  })

  it('stops at the first complete object and ignores trailing prose', () => {
    expect(extractJsonObject('{"amount":1} and then some chatter {"amount":2}')).toEqual({ amount: 1 })
  })

  it('returns null when there is nothing parseable', () => {
    expect(extractJsonObject('I could not parse that email.')).toBeNull()
    expect(extractJsonObject('{"unterminated": ')).toBeNull()
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject(null)).toBeNull()
  })
})
