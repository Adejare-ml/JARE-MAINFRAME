import { describe, it, expect } from 'vitest'
import { runQuery, describeQueries, QUERY_NAMES } from '../src/lib/nlQuery.js'

/**
 * The gate between "a model wants an answer" and "code ran". Every test here
 * asks whether a call that should never execute actually didn't.
 */

const context = {
  monthTransactions: [
    { type: 'debit', amount: 8000, category: 'Transport', wallet_id: 'w1' },
    { type: 'debit', amount: 15000, category: 'Feeding / Groceries', wallet_id: 'w1' },
    { type: 'credit', amount: 150000, category: 'Salary', wallet_id: 'w1' },
  ],
  liquidWalletIds: new Set(['w1']),
  goals: [
    { id: 'g1', metric: 'save_at_least', target_amount: 50000, metric_wallet_id: 'w1' },
  ],
  goalTransactions: [{ type: 'credit', amount: 20000, wallet_id: 'w1' }],
  wallets: [{ id: 'w1', name: 'GTBank', balance: 123456.78 }],
  debts: [
    { direction: 'i_owe', principal: 50000, amount_paid: 20000, settled: false, kind: 'loan' },
  ],
}

describe('runQuery — unknown or malformed calls', () => {
  it('refuses a function name not on the list', () => {
    const result = runQuery({ function: 'dropAllTables' }, context)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not one of the questions this app can answer/)
  })

  it('refuses junk instead of a call', () => {
    for (const junk of [null, undefined, 'spendThisMonth', 42, [], { function: null }]) {
      const result = runQuery(junk, context)
      expect(result.ok).toBe(false)
    }
  })

  it('refuses a call missing a required argument', () => {
    const result = runQuery({ function: 'spendByCategory', args: {} }, context)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/missing required argument "category"/)
  })

  it('refuses a wrong-typed argument', () => {
    const result = runQuery({ function: 'spendByCategory', args: { category: 42 } }, context)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/"category" must be a string/)
  })

  it('refuses an argument the function never declared', () => {
    const result = runQuery({ function: 'spendThisMonth', args: { category: 'Transport' } }, context)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/"category" is not a recognised argument/)
  })

  it('never runs the function when validation fails', () => {
    // If this ever ran, it would throw on the missing category rather than
    // return a validation error -- so a thrown error here would mean the
    // whitelist was bypassed, not enforced.
    expect(() => runQuery({ function: 'spendByCategory', args: {} }, context)).not.toThrow()
  })
})

describe('runQuery — real calls', () => {
  it('answers spendThisMonth from summarizeMonth, not a re-derived total', () => {
    const result = runQuery({ function: 'spendThisMonth' }, context)
    expect(result).toEqual({ ok: true, result: { spent: 23000 } })
  })

  it('answers spendByCategory case-insensitively', () => {
    const result = runQuery({ function: 'spendByCategory', args: { category: 'transport' } }, context)
    expect(result.ok).toBe(true)
    expect(result.result).toEqual({ category: 'transport', total: 8000 })
  })

  it('answers zero for a category with nothing spent, not an error', () => {
    const result = runQuery({ function: 'spendByCategory', args: { category: 'Rent' } }, context)
    expect(result).toEqual({ ok: true, result: { category: 'Rent', total: 0 } })
  })

  it('answers goalProgressFor by id', () => {
    const result = runQuery({ function: 'goalProgressFor', args: { goalId: 'g1' } }, context)
    expect(result.ok).toBe(true)
    expect(result.result.found).toBe(true)
    expect(result.result.done).toBe(20000)
  })

  it('answers found: false for a goal id that does not exist, not an error', () => {
    const result = runQuery({ function: 'goalProgressFor', args: { goalId: 'nope' } }, context)
    expect(result).toEqual({ ok: true, result: { found: false } })
  })

  it('answers walletBalance by name, case-insensitively', () => {
    const result = runQuery({ function: 'walletBalance', args: { walletName: 'gtbank' } }, context)
    expect(result).toEqual({ ok: true, result: { found: true, balance: 123456.78 } })
  })

  it('answers found: false for a wallet that does not exist', () => {
    const result = runQuery({ function: 'walletBalance', args: { walletName: 'Swiss Vault' } }, context)
    expect(result).toEqual({ ok: true, result: { found: false } })
  })

  it('answers debtsOutstanding from debtTotals', () => {
    const result = runQuery({ function: 'debtsOutstanding' }, context)
    expect(result.ok).toBe(true)
    expect(result.result.iOwe).toBe(30000)
  })

  it('never lets a wrong-shaped context crash the caller', () => {
    const result = runQuery({ function: 'spendThisMonth' }, {})
    expect(result.ok).toBe(true)
    expect(result.result.spent).toBe(0)
  })
})

describe('describeQueries', () => {
  it('lists every function in QUERY_NAMES, with its declared arguments', () => {
    const described = describeQueries()
    expect(described.map((q) => q.name).sort()).toEqual([...QUERY_NAMES].sort())

    const byCategory = described.find((q) => q.name === 'spendByCategory')
    expect(byCategory.params).toEqual([{ name: 'category', type: 'string', required: true }])

    const thisMonth = described.find((q) => q.name === 'spendThisMonth')
    expect(thisMonth.params).toEqual([])
  })
})
