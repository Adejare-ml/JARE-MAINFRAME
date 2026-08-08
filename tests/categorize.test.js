import { describe, it, expect } from 'vitest'
import {
  applyCategoryOverrides,
  coerceCategory,
  combineConfidence,
} from '../src/lib/sync/categorize.js'
import { ALL_CATEGORIES } from '../src/lib/constants.js'
import { TRANSFER_CATEGORIES, summarizeMonth } from '../src/lib/summary.js'

describe('applyCategoryOverrides', () => {
  it('leaves a sensible model answer alone', () => {
    const result = applyCategoryOverrides(
      { type: 'debit', category: 'Transport', description: 'Bolt ride' },
      { type: 'bank' },
    )
    expect(result).toEqual({ category: 'Transport', reason: null })
  })

  it('files inflows to a savings wallet as Savings', () => {
    const result = applyCategoryOverrides(
      { type: 'credit', category: 'Miscellaneous', description: 'Deposit' },
      { type: 'savings' },
    )
    expect(result.category).toBe('Savings')
  })

  it('files inflows to an investment wallet as Investment', () => {
    expect(
      applyCategoryOverrides({ type: 'credit', category: 'Uncategorized' }, { type: 'investment' })
        .category,
    ).toBe('Investment')
  })

  // Taking money *out* of savings is not a savings deposit.
  it('does not touch outflows from a savings wallet', () => {
    const result = applyCategoryOverrides(
      { type: 'debit', category: 'Rent', description: 'Withdrawal to bank' },
      { type: 'savings' },
    )
    expect(result.category).toBe('Rent')
  })

  it('recognises charges by narration', () => {
    for (const description of [
      'STAMP DUTY CHARGE',
      'SMS Alert Charge',
      'Account Maintenance Fee',
      'VAT on transfer',
      'COT',
      'Transfer Fee',
    ]) {
      expect(applyCategoryOverrides({ type: 'debit', description }, { type: 'bank' }).category).toBe(
        'Bank Charges',
      )
    }
  })

  // A stamp duty debit on a savings wallet is a charge, not a savings movement,
  // so charges are tested before the wallet-type rule.
  it('ranks charges above the wallet-type rule', () => {
    const result = applyCategoryOverrides(
      { type: 'credit', category: 'Miscellaneous', description: 'VAT reversal' },
      { type: 'savings' },
    )
    expect(result.category).toBe('Bank Charges')
  })

  it('files ATM withdrawals as a transfer to cash, not spending', () => {
    for (const description of ['ATM WITHDRAWAL LAGOS', 'Cash withdrawal', 'Withdrawal at GTB ATM']) {
      expect(applyCategoryOverrides({ type: 'debit', description }, { type: 'bank' }).category).toBe(
        'Cash Withdrawal',
      )
    }
  })

  it('does not treat an ATM credit as a withdrawal', () => {
    const result = applyCategoryOverrides(
      { type: 'credit', category: 'Uncategorized', description: 'ATM refund' },
      { type: 'bank' },
    )
    expect(result.category).toBe('Uncategorized')
  })

  it('matches on recipient as well as description', () => {
    expect(
      applyCategoryOverrides(
        { type: 'debit', description: 'Transfer', recipient: 'STAMP DUTY' },
        { type: 'bank' },
      ).category,
    ).toBe('Bank Charges')
  })

  it('explains why it overrode, for the run log', () => {
    expect(applyCategoryOverrides({ type: 'credit' }, { type: 'savings' }).reason).toContain('savings')
  })

  it('survives missing input', () => {
    expect(applyCategoryOverrides({}, null).category).toBe('Uncategorized')
    expect(applyCategoryOverrides(null, null).category).toBe('Uncategorized')
  })
})

describe('coerceCategory', () => {
  it('accepts a category from the list', () => {
    expect(coerceCategory('Transport')).toEqual({ category: 'Transport', known: true })
  })

  it('forgives a case-only mismatch from the model', () => {
    expect(coerceCategory('transport')).toEqual({ category: 'Transport', known: true })
    expect(coerceCategory('  FEEDING / GROCERIES ')).toEqual({
      category: 'Feeding / Groceries',
      known: true,
    })
  })

  // Reported as unknown rather than silently accepted, so the batch layer can
  // count how often the model invents categories.
  it('reports an invented category as unknown', () => {
    expect(coerceCategory('Crypto Gambling')).toEqual({ category: 'Uncategorized', known: false })
    expect(coerceCategory('')).toEqual({ category: 'Uncategorized', known: false })
    expect(coerceCategory(null)).toEqual({ category: 'Uncategorized', known: false })
  })
})

describe('combineConfidence', () => {
  // A confidently-filed transaction pointing the wrong way is worse than an
  // obviously unsure one, so HIGH needs both halves settled.
  it('is HIGH only when direction and category are both settled', () => {
    expect(
      combineConfidence({
        directionConfidence: 'HIGH',
        categoryConfidence: 'HIGH',
        categoryKnown: true,
      }),
    ).toBe('HIGH')
  })

  it('is LOW when the direction was guessed', () => {
    expect(
      combineConfidence({ directionConfidence: 'LOW', categoryConfidence: 'HIGH', categoryKnown: true }),
    ).toBe('LOW')
  })

  it('is LOW when the category was guessed or invented', () => {
    expect(
      combineConfidence({ directionConfidence: 'HIGH', categoryConfidence: 'LOW', categoryKnown: true }),
    ).toBe('LOW')
    expect(
      combineConfidence({
        directionConfidence: 'HIGH',
        categoryConfidence: 'HIGH',
        categoryKnown: false,
      }),
    ).toBe('LOW')
  })

  it('is LOW when nothing is known', () => {
    expect(combineConfidence({})).toBe('LOW')
  })
})

// The coupling that silently broke Track B's month totals once already: a
// transfer category that is not in both lists starts counting as spending.
describe('transfer categories stay in sync with the category list', () => {
  it('every transfer category is a real category', () => {
    for (const category of TRANSFER_CATEGORIES) {
      expect(ALL_CATEGORIES).toContain(category)
    }
  })

  it('covers both legs of the new savings and investment inflows', () => {
    expect(TRANSFER_CATEGORIES).toContain('Savings')
    expect(TRANSFER_CATEGORIES).toContain('Investment')
  })

  it('keeps a PiggyVest deposit out of both income and spending', () => {
    const liquid = new Set(['gt'])
    const summary = summarizeMonth(
      [
        // The debit leg on GTBank, and the credit leg on PiggyVest.
        { type: 'debit', amount: 50000, category: 'Savings Transfer', wallet_id: 'gt' },
        { type: 'credit', amount: 50000, category: 'Savings', wallet_id: 'piggyvest' },
      ],
      liquid,
    )

    expect(summary.spent).toBe(0)
    expect(summary.income).toBe(0)
    // Counted once, from the debit leg only.
    expect(summary.movedAside).toBe(50000)
  })
})
