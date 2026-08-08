import { describe, it, expect } from 'vitest'
import {
  directionFromBalance,
  hasReliableDirection,
  BalanceChain,
  sortChronologically,
} from '../src/lib/sync/direction.js'

describe('directionFromBalance', () => {
  // The whole point: Opay says "transfer" for both directions, but the balance
  // afterwards tells you which one it was.
  it('reads a falling balance as money out', () => {
    expect(directionFromBalance(5808.09, 8408.09)).toEqual({ type: 'debit', confidence: 'HIGH' })
  })

  it('reads a rising balance as money in', () => {
    expect(directionFromBalance(20808.09, 5808.09)).toEqual({ type: 'credit', confidence: 'HIGH' })
  })

  // Both are "cannot tell", not "assume debit" — a wrong direction corrupts the
  // monthly totals, so the caller hands off to the LLM instead of guessing.
  it('gives no answer when there is no prior balance', () => {
    expect(directionFromBalance(5000, null)).toBeNull()
    expect(directionFromBalance(5000, undefined)).toBeNull()
  })

  it('gives no answer when the balance did not move', () => {
    expect(directionFromBalance(5000, 5000)).toBeNull()
  })

  it('gives no answer when this alert states no balance', () => {
    expect(directionFromBalance(null, 5000)).toBeNull()
    expect(directionFromBalance('not a number', 5000)).toBeNull()
  })

  // Guards against a parser producing 5808.089999999999 and that reading as a
  // movement of a hundredth of a kobo.
  it('ignores float noise below a kobo', () => {
    expect(directionFromBalance(5808.09, 5808.0900001)).toBeNull()
  })

  it('accepts a movement of exactly one kobo', () => {
    expect(directionFromBalance(5808.08, 5808.09).type).toBe('debit')
  })

  it('handles numeric strings, as Postgres returns for numeric columns', () => {
    expect(directionFromBalance('5808.09', '8408.09').type).toBe('debit')
  })

  it('handles a balance falling to zero', () => {
    expect(directionFromBalance(0, 2600).type).toBe('debit')
  })
})

describe('hasReliableDirection', () => {
  it('trusts a direction the email stated outright', () => {
    expect(hasReliableDirection({ type: 'debit', direction_source: 'label' })).toBe(true)
  })

  it('does not trust a keyword guess', () => {
    expect(hasReliableDirection({ type: 'debit', direction_source: 'guess' })).toBe(false)
  })

  // The spec is explicit: arithmetic outranks the model wherever a prior
  // balance exists.
  it('does not trust the model’s inference either', () => {
    expect(hasReliableDirection({ type: 'credit', direction_source: 'llm' })).toBe(false)
  })

  // The bug this replaced: `confidence` describes how sure the parser is about
  // the *category*, so keying on it meant a GTBank alert with an explicit DEBIT
  // label was re-derived from balance movement whenever its category was
  // uncertain — and marked LOW if no balance was stated.
  it('ignores confidence, which is about the category', () => {
    expect(hasReliableDirection({ type: 'debit', direction_source: 'label', confidence: 'LOW' })).toBe(true)
    expect(hasReliableDirection({ type: 'debit', direction_source: 'guess', confidence: 'HIGH' })).toBe(false)
  })

  it('handles missing input', () => {
    expect(hasReliableDirection(null)).toBe(false)
    expect(hasReliableDirection({ direction_source: 'label' })).toBe(false)
  })
})

describe('BalanceChain', () => {
  const wallets = [
    { id: 'opay', balance: 8408.09 },
    { id: 'gt', balance: 50000 },
    { id: 'fresh', balance: null },
  ]

  it('starts from the wallet’s stored balance', () => {
    expect(new BalanceChain(wallets).priorFor('opay')).toBe(8408.09)
  })

  it('reports no prior for a wallet that has never had one', () => {
    expect(new BalanceChain(wallets).priorFor('fresh')).toBeNull()
    expect(new BalanceChain(wallets).priorFor('unknown-wallet')).toBeNull()
  })

  it('advances as alerts are observed', () => {
    const chain = new BalanceChain(wallets)
    chain.observe('opay', 5808.09)
    expect(chain.priorFor('opay')).toBe(5808.09)
  })

  it('keeps wallets independent', () => {
    const chain = new BalanceChain(wallets)
    chain.observe('opay', 100)
    expect(chain.priorFor('gt')).toBe(50000)
  })

  it('ignores alerts that state no balance', () => {
    const chain = new BalanceChain(wallets)
    chain.observe('opay', null)
    expect(chain.priorFor('opay')).toBe(8408.09)
  })

  // The re-scan overlap: each sync re-reads an hour of already-seen mail. Those
  // duplicates are not inserted, but they must still move the chain or the
  // first genuinely-new alert compares against a stale balance.
  it('chains correctly through a duplicate that was not inserted', () => {
    const chain = new BalanceChain(wallets)

    // Already-seen alert: balance matches stored, so direction is unknowable.
    expect(directionFromBalance(8408.09, chain.priorFor('opay'))).toBeNull()
    chain.observe('opay', 8408.09) // observed anyway, though not inserted

    // The next alert now has the right predecessor.
    expect(directionFromBalance(5808.09, chain.priorFor('opay'))).toEqual({
      type: 'debit',
      confidence: 'HIGH',
    })
  })

  it('resolves a whole day of alerts in sequence', () => {
    const chain = new BalanceChain([{ id: 'opay', balance: 10000 }])
    const alerts = [7400, 12400, 9800] // out, in, out
    const directions = alerts.map((balance) => {
      const d = directionFromBalance(balance, chain.priorFor('opay'))
      chain.observe('opay', balance)
      return d?.type
    })

    expect(directions).toEqual(['debit', 'credit', 'debit'])
  })
})

describe('sortChronologically', () => {
  it('reverses Gmail’s newest-first order', () => {
    const sorted = sortChronologically([
      { id: 'c', internalDate: '3000' },
      { id: 'a', internalDate: '1000' },
      { id: 'b', internalDate: '2000' },
    ])
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    const input = [{ id: 'b', internalDate: '2000' }, { id: 'a', internalDate: '1000' }]
    sortChronologically(input)
    expect(input.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('puts messages with no date first rather than dropping them', () => {
    const sorted = sortChronologically([{ id: 'dated', internalDate: '1000' }, { id: 'undated' }])
    expect(sorted.map((m) => m.id)).toEqual(['undated', 'dated'])
  })

  it('handles empty and missing input', () => {
    expect(sortChronologically([])).toEqual([])
    expect(sortChronologically(null)).toEqual([])
  })
})
