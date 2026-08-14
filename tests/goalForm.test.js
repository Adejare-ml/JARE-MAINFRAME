import { describe, it, expect } from 'vitest'
import { validateGoal } from '../src/components/goals/GoalForm.jsx'

/**
 * These mirror migration 009's `goals_metric_needs_target` check:
 *
 *   check (metric = 'manual'
 *          or (target_amount is not null and target_amount > 0
 *              and (metric_category is not null or metric_wallet_id is not null)))
 *
 * The database refuses the same rows either way. The difference is whether the
 * user is told what to fix, or shown SQLSTATE 23514 naming a constraint.
 */

const measured = {
  title: 'Laptop fund',
  metric: 'save_at_least',
  target_amount: '150000',
  metric_category: 'Savings',
  metric_wallet_id: '',
}

describe('validateGoal', () => {
  it('accepts a complete measured goal', () => {
    expect(validateGoal(measured)).toBe(null)
  })

  it('accepts a manual goal with nothing but a title', () => {
    expect(
      validateGoal({ title: 'Call the bank', metric: 'manual', target_amount: '' }),
    ).toBe(null)
  })

  it('needs a title', () => {
    expect(validateGoal({ ...measured, title: '' })).toBeTruthy()
    expect(validateGoal({ ...measured, title: '   ' })).toBeTruthy()
  })

  it('needs an amount above zero when it is measured', () => {
    for (const target_amount of ['', '0', '-5', 'abc']) {
      expect(validateGoal({ ...measured, target_amount })).toBeTruthy()
    }
  })

  it('needs something to measure against', () => {
    // This is the half most easily missed: an amount with no category and no
    // wallet passes a naive "is the number filled in" check and is then
    // rejected by the database.
    expect(
      validateGoal({ ...measured, metric_category: '', metric_wallet_id: '' }),
    ).toBeTruthy()
  })

  it('accepts a wallet instead of a category', () => {
    expect(
      validateGoal({ ...measured, metric_category: '', metric_wallet_id: 'w1' }),
    ).toBe(null)
  })

  it('does not demand an amount from a manual goal', () => {
    // A reminder has nothing to measure, so requiring a number would make the
    // simplest kind of goal the hardest to create.
    expect(
      validateGoal({ title: 'Renew NIN', metric: 'manual', target_amount: '', metric_category: '' }),
    ).toBe(null)
  })

  it('applies the same rule to a spending cap', () => {
    expect(validateGoal({ ...measured, metric: 'spend_under' })).toBe(null)
    expect(
      validateGoal({ ...measured, metric: 'spend_under', target_amount: '' }),
    ).toBeTruthy()
  })

  it('phrases the problem as something a person would say', () => {
    // House style, set by Debts' "Who is this with?". A validation message that
    // reads like a schema comment gets ignored.
    const message = validateGoal({ ...measured, title: '' })
    expect(message).toMatch(/\?$|[a-z]$/)
    expect(message).not.toMatch(/null|constraint|invalid|23514/i)
  })

  it('survives being handed nothing', () => {
    expect(validateGoal({})).toBeTruthy()
    expect(validateGoal(undefined)).toBeTruthy()
  })
})
