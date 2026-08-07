import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseGTBankEmail } from '../src/lib/parsers/gtbank.js'
import { parseOpayEmail } from '../src/lib/parsers/opay.js'
import { ALL_CATEGORIES } from '../src/lib/constants.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'emails')
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.txt`), 'utf-8')

describe('parseGTBankEmail', () => {
  it('reads a debit alert', () => {
    const txn = parseGTBankEmail(fixture('gtbank-debit'))

    expect(txn.type).toBe('debit')
    expect(txn.amount).toBe(20000)
    expect(txn.transaction_date).toBe('2026-07-29')
    expect(txn.transaction_time).toBe('20:02:23')
    expect(txn.transaction_id).toBe('044884719406769l5872')
    expect(txn.available_balance).toBe(50000.7)
    expect(txn.source).toBe('gtbank')
  })

  it('reads a credit alert as a credit', () => {
    // Regression: credits were being logged as debits.
    const txn = parseGTBankEmail(fixture('gtbank-credit'))

    expect(txn.type).toBe('credit')
    expect(txn.amount).toBe(150000)
    expect(txn.transaction_date).toBe('2026-07-25')
    expect(txn.transaction_time).toBe('09:15:04')
    expect(txn.available_balance).toBe(201455.3)
  })

  it('converts 12-hour times correctly at the AM/PM boundaries', () => {
    const noon = parseGTBankEmail(fixture('gtbank-debit').replace('8:02:23 PM', '12:30:00 PM'))
    expect(noon.transaction_time).toBe('12:30:00')

    const midnight = parseGTBankEmail(fixture('gtbank-debit').replace('8:02:23 PM', '12:30:00 AM'))
    expect(midnight.transaction_time).toBe('00:30:00')
  })

  it('returns a null transaction_id when Document Number is empty', () => {
    // Charge and stamp-duty alerts ship no reference. The caller has to
    // synthesise a dedup key; what matters here is that we report the absence
    // rather than inventing a value or picking up the next line.
    const txn = parseGTBankEmail(fixture('gtbank-charge-no-docnum'))

    expect(txn.transaction_id).toBeNull()
    expect(txn.type).toBe('debit')
    expect(txn.amount).toBe(50)
  })

  it('only ever emits categories the app knows about', () => {
    for (const name of ['gtbank-debit', 'gtbank-credit', 'gtbank-charge-no-docnum']) {
      expect(ALL_CATEGORIES).toContain(parseGTBankEmail(fixture(name)).category)
    }
  })

  it('returns null for junk input', () => {
    expect(parseGTBankEmail(null)).toBeNull()
    expect(parseGTBankEmail('')).toBeNull()
    expect(parseGTBankEmail(123)).toBeNull()
  })
})

describe('parseOpayEmail', () => {
  it('reads an outgoing transfer', () => {
    const txn = parseOpayEmail(fixture('opay-out'))

    expect(txn.type).toBe('debit')
    expect(txn.amount).toBe(2600)
    expect(txn.transaction_date).toBe('2026-07-30')
    expect(txn.transaction_time).toBe('10:30:09')
    expect(txn.transaction_id).toBe('260730020100173482925656')
    expect(txn.available_balance).toBe(5808.09)
    expect(txn.source).toBe('opay')
  })

  it('parses ordinal dates across months', () => {
    const txn = parseOpayEmail(fixture('opay-out').replace('Jul 30th, 2026', 'Dec 1st, 2026'))
    expect(txn.transaction_date).toBe('2026-12-01')
  })

  it('only ever emits categories the app knows about', () => {
    for (const name of ['opay-out', 'opay-in']) {
      expect(ALL_CATEGORIES).toContain(parseOpayEmail(fixture(name)).category)
    }
  })

  it('returns null for junk input', () => {
    expect(parseOpayEmail(null)).toBeNull()
    expect(parseOpayEmail('')).toBeNull()
  })

  // This is the documented reason Opay wallets are routed to the LLM rather
  // than to these rules. Opay says "transfer" for money in and money out, so
  // direction is not recoverable from the wording. The assertion below records
  // the failure deliberately: if someone ever "fixes" the rules parser, this
  // test tells them to re-check the routing in src/lib/sync/wallets.js.
  it('cannot determine direction from wording alone (known limitation)', () => {
    const incoming = parseOpayEmail(fixture('opay-in'))

    expect(incoming.amount).toBe(15000)
    expect(incoming.transaction_id).toBe('260731020100173482991234')
    // Wrong, and unfixable at this layer -- hence parse_strategy: 'llm'.
    expect(incoming.type).toBe('debit')
    expect(incoming.confidence).toBe('LOW')
  })
})
