import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOpayEmail } from '../src/lib/parsers/opay.js'
import { parseGTBankEmail } from '../src/lib/parsers/gtbank.js'
import {
  BalanceChain,
  directionFromBalance,
  hasReliableDirection,
} from '../src/lib/sync/direction.js'
import { validateParsedTransaction } from '../src/lib/sync/normalize.js'

/**
 * End-to-end proof that Opay direction is now decided by arithmetic.
 *
 * The Opay parser's own guess is wrong for incoming transfers, because the
 * alert wording is identical in both directions. These fixtures are internally
 * consistent — each states the balance after the transfer — so the balance
 * chain has to recover the truth the wording cannot carry.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'emails')
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.txt`), 'utf-8')

/** The sync's direction resolution, in the same order the real one uses. */
function resolveDirection(parsed, chain, walletId) {
  if (hasReliableDirection(parsed)) return { ...parsed, resolvedBy: 'label' }

  const fromBalance = directionFromBalance(parsed.available_balance, chain.priorFor(walletId))
  return fromBalance
    ? { ...parsed, ...fromBalance, resolvedBy: 'balance' }
    : { ...parsed, confidence: 'LOW', resolvedBy: 'unresolved' }
}

describe('Opay direction by balance movement', () => {
  const OPAY = 'opay-wallet-id'

  it('reads the fixtures as a consistent balance chain', () => {
    // ₦8,408.09 − ₦2,600 = ₦5,808.09, then + ₦15,000 = ₦20,808.09.
    const out = parseOpayEmail(fixture('opay-out'))
    const incoming = parseOpayEmail(fixture('opay-in'))

    expect(out.amount).toBe(2600)
    expect(out.available_balance).toBe(5808.09)
    expect(incoming.amount).toBe(15000)
    expect(incoming.available_balance).toBe(20808.09)
  })

  it('resolves an outgoing transfer as a debit', () => {
    const chain = new BalanceChain([{ id: OPAY, balance: 8408.09 }])
    const resolved = resolveDirection(parseOpayEmail(fixture('opay-out')), chain, OPAY)

    expect(resolved.type).toBe('debit')
    expect(resolved.confidence).toBe('HIGH')
    expect(resolved.resolvedBy).toBe('balance')
  })

  // The case the keyword parser gets wrong: identical wording, opposite meaning.
  it('resolves an incoming transfer as a credit, which the wording cannot', () => {
    const rules = parseOpayEmail(fixture('opay-in'))
    expect(rules.type).toBe('debit') // the guess, and it is wrong

    const chain = new BalanceChain([{ id: OPAY, balance: 5808.09 }])
    const resolved = resolveDirection(rules, chain, OPAY)

    expect(resolved.type).toBe('credit')
    expect(resolved.confidence).toBe('HIGH')
  })

  it('walks a whole day in order, correcting as it goes', () => {
    const chain = new BalanceChain([{ id: OPAY, balance: 8408.09 }])

    const outcomes = ['opay-out', 'opay-in'].map((name) => {
      const parsed = parseOpayEmail(fixture(name))
      const resolved = resolveDirection(parsed, chain, OPAY)
      chain.observe(OPAY, parsed.available_balance)
      return resolved.type
    })

    expect(outcomes).toEqual(['debit', 'credit'])
    expect(chain.priorFor(OPAY)).toBe(20808.09)
  })

  // A wallet with no stored balance has nothing to compare against. It must
  // degrade to review, not to a confident guess.
  it('sends the first ever alert to review rather than guessing', () => {
    const chain = new BalanceChain([{ id: OPAY, balance: null }])
    const resolved = resolveDirection(parseOpayEmail(fixture('opay-out')), chain, OPAY)

    expect(resolved.resolvedBy).toBe('unresolved')
    expect(resolved.confidence).toBe('LOW')
  })

  it('produces a row the validator accepts and marks reviewed', () => {
    const chain = new BalanceChain([{ id: OPAY, balance: 8408.09 }])
    const resolved = resolveDirection(parseOpayEmail(fixture('opay-out')), chain, OPAY)

    // Direction settled by arithmetic and a category the model was sure about.
    const check = validateParsedTransaction({
      ...resolved,
      source: 'opay',
      category: 'Family Support',
      confidence: 'HIGH',
      explanation: 'Transfer sent to Rejoice Ene Joseph via Opay.',
    })

    expect(check.ok).toBe(true)
    expect(check.value.type).toBe('debit')
    // HIGH confidence is auto-accepted: it never reaches the review queue.
    expect(check.value.reviewed).toBe(true)
    expect(check.value.explanation).toBe('Transfer sent to Rejoice Ene Joseph via Opay.')
  })

  it('keeps a LOW-confidence row unreviewed so it surfaces for a decision', () => {
    const check = validateParsedTransaction({
      type: 'debit',
      amount: 2600,
      transaction_date: '2026-07-30',
      transaction_time: '10:30:09',
      category: 'Uncategorized',
      confidence: 'LOW',
      source: 'opay',
    })

    expect(check.value.reviewed).toBe(false)
  })

  // A GTBank alert states DEBIT outright, so the balance chain never runs --
  // even when the stored balance would imply the opposite, which is what
  // happens after a missed alert leaves the stored balance stale.
  it('leaves an explicitly-labelled bank alert alone', () => {
    const chain = new BalanceChain([{ id: 'gt', balance: 999999 }])
    const labelled = {
      type: 'credit',
      direction_source: 'label',
      confidence: 'LOW',
      available_balance: 1,
    }

    expect(resolveDirection(labelled, chain, 'gt')).toMatchObject({
      type: 'credit',
      resolvedBy: 'label',
    })
  })

  it('trusts the label on a real GTBank fixture rather than re-deriving it', () => {
    const debit = parseGTBankEmail(fixture('gtbank-debit'))
    const credit = parseGTBankEmail(fixture('gtbank-credit'))

    expect(debit.direction_source).toBe('label')
    expect(hasReliableDirection(debit)).toBe(true)

    // A stale stored balance must not be able to flip a stated direction.
    const chain = new BalanceChain([{ id: 'gt', balance: 0 }])
    expect(resolveDirection(debit, chain, 'gt')).toMatchObject({ type: 'debit', resolvedBy: 'label' })
    expect(resolveDirection(credit, chain, 'gt')).toMatchObject({ type: 'credit', resolvedBy: 'label' })
  })
})
