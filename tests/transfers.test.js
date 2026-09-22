import { describe, it, expect } from 'vitest'
import { transferCategories, isTransferPair, validateTransfer, TRANSFER_OUT, TRANSFER_IN } from '../src/lib/transfers.js'
import { TRANSFER_CATEGORIES } from '../src/lib/summary.js'
import { ALL_CATEGORIES } from '../src/lib/constants.js'

const W = (type, id = type) => ({ id, type })

describe('transferCategories', () => {
  it('files a move into savings or investment the way the ledger already does', () => {
    expect(transferCategories(W('bank'), W('savings'))).toEqual(['Savings Transfer', 'Savings'])
    expect(transferCategories(W('mobile'), W('investment'))).toEqual(['Savings Transfer', 'Investment'])
  })

  it('files a withdrawal to cash as the ATM pair', () => {
    expect(transferCategories(W('bank'), W('cash'))).toEqual(['Cash Withdrawal', 'Cash Received'])
  })

  it('uses the generic pair for everything else, including out of savings and cash to cash', () => {
    expect(transferCategories(W('bank'), W('mobile'))).toEqual([TRANSFER_OUT, TRANSFER_IN])
    expect(transferCategories(W('savings'), W('bank'))).toEqual([TRANSFER_OUT, TRANSFER_IN])
    expect(transferCategories(W('cash', 'a'), W('cash', 'b'))).toEqual([TRANSFER_OUT, TRANSFER_IN])
    expect(transferCategories(null, null)).toEqual([TRANSFER_OUT, TRANSFER_IN])
  })

  // The property the whole module exists for: summarizeMonth must never see
  // a transfer leg as spending or income.
  it('only ever returns transfer categories that the app also knows by name', () => {
    const types = ['bank', 'mobile', 'cash', 'savings', 'investment', undefined]
    for (const a of types) {
      for (const b of types) {
        const pair = transferCategories(W(a, 'a'), W(b, 'b'))
        expect(isTransferPair(pair)).toBe(true)
        for (const c of pair) expect(ALL_CATEGORIES).toContain(c)
      }
    }
  })
})

describe('the generic pair', () => {
  it('is in TRANSFER_CATEGORIES, so both legs are excluded from totals', () => {
    expect(TRANSFER_CATEGORIES).toContain(TRANSFER_OUT)
    expect(TRANSFER_CATEGORIES).toContain(TRANSFER_IN)
  })
})

describe('validateTransfer', () => {
  it('accepts two different wallets and a positive amount', () => {
    expect(validateTransfer({ from: W('bank', 'a'), to: W('cash', 'b'), amount: '2500' })).toEqual({ ok: true })
  })

  it('refuses a missing wallet, the same wallet twice, and a non-positive amount', () => {
    expect(validateTransfer({ from: null, to: W('cash'), amount: 10 }).ok).toBe(false)
    expect(validateTransfer({ from: W('bank', 'a'), to: W('bank', 'a'), amount: 10 }).error).toMatch(/different/)
    expect(validateTransfer({ from: W('bank', 'a'), to: W('cash', 'b'), amount: 0 }).ok).toBe(false)
    expect(validateTransfer({ from: W('bank', 'a'), to: W('cash', 'b'), amount: 'ten' }).ok).toBe(false)
  })
})
