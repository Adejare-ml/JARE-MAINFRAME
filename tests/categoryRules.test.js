import { describe, it, expect } from 'vitest'
import {
  RULE_FIELD,
  normalizePayee,
  ruleFromTransaction,
  findMatchingRule,
  likeLiteral,
  ruleExplanation,
} from '../src/lib/categoryRules.js'

describe('normalizePayee', () => {
  it('collapses whitespace and trims, keeping case', () => {
    expect(normalizePayee('  NANDIP   MAMTUR\tLADONG ')).toBe('NANDIP MAMTUR LADONG')
    expect(normalizePayee(null)).toBe('')
    expect(normalizePayee(undefined)).toBe('')
  })
})

describe('ruleFromTransaction', () => {
  it('keys on the recipient and files under the chosen category', () => {
    expect(ruleFromTransaction({ recipient: ' Nandip  Mamtur Ladong' }, 'Family Support')).toEqual({
      trigger_field: RULE_FIELD,
      trigger_value: 'Nandip Mamtur Ladong',
      action_category: 'Family Support',
      priority: 0,
    })
  })

  it('is null when there is no payee to key on', () => {
    expect(ruleFromTransaction({ recipient: null, description: 'WEB PUR CANVA' }, 'Tools & Software')).toBeNull()
    expect(ruleFromTransaction({ recipient: '   ' }, 'Transport')).toBeNull()
    expect(ruleFromTransaction(null, 'Transport')).toBeNull()
  })

  it('is null for Uncategorized, which is not a decision', () => {
    expect(ruleFromTransaction({ recipient: 'PAYSTACK CHECKOUT' }, 'Uncategorized')).toBeNull()
    expect(ruleFromTransaction({ recipient: 'PAYSTACK CHECKOUT' }, '')).toBeNull()
  })
})

describe('findMatchingRule', () => {
  const rules = [
    { id: 'a', trigger_field: 'recipient', trigger_value: 'nandip  mamtur ladong', action_category: 'Miscellaneous' },
    { id: 'b', trigger_field: 'description', trigger_value: 'NANDIP MAMTUR LADONG', action_category: 'Transport' },
  ]

  it('matches the same field ignoring case and spacing', () => {
    const rule = ruleFromTransaction({ recipient: 'NANDIP MAMTUR LADONG' }, 'Family Support')
    expect(findMatchingRule(rules, rule)?.id).toBe('a')
  })

  it('does not match a rule on a different field', () => {
    const rule = { trigger_field: 'description', trigger_value: 'nandip mamtur ladong' }
    expect(findMatchingRule(rules, rule)?.id).toBe('b')
    expect(findMatchingRule([rules[0]], rule)).toBeNull()
  })

  it('is null for no rules or no rule', () => {
    expect(findMatchingRule([], { trigger_field: 'recipient', trigger_value: 'x' })).toBeNull()
    expect(findMatchingRule(rules, null)).toBeNull()
    expect(findMatchingRule(null, { trigger_field: 'recipient', trigger_value: 'x' })).toBeNull()
  })
})

describe('likeLiteral', () => {
  it('escapes the wildcards and the escape character', () => {
    expect(likeLiteral('50% OFF_LTD \\ CO')).toBe('50\\% OFF\\_LTD \\\\ CO')
  })

  it('leaves an ordinary payee alone', () => {
    expect(likeLiteral('  David Chijioke  Azubuike ')).toBe('David Chijioke Azubuike')
  })
})

describe('ruleExplanation', () => {
  it('names the field and the value', () => {
    expect(ruleExplanation({ trigger_field: 'recipient', trigger_value: 'NANDIP MAMTUR LADONG' })).toBe(
      'Filed by your rule: recipient contains "NANDIP MAMTUR LADONG"',
    )
  })
})
