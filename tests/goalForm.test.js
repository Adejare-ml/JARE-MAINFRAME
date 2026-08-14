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

describe('validateGoal on a goal about code', () => {
  const repo = {
    title: 'Ship the planner',
    metric: 'repo_commits',
    target_amount: '40',
    metric_category: '',
    metric_wallet_id: '',
  }

  it('accepts a repo goal with no category and no wallet', () => {
    // The row the old rule refused. Migration 010 amends
    // `goals_metric_needs_target` in exactly this shape -- a repo goal is
    // measured by the repository, which is configuration rather than a column
    // -- and the two have to agree or the form rejects rows the database would
    // take, or the reverse.
    expect(validateGoal(repo)).toBe(null)
  })

  it('still needs a number above zero', () => {
    for (const target_amount of ['', '0', '-2', 'lots']) {
      expect(validateGoal({ ...repo, target_amount })).toBeTruthy()
    }
  })

  it('asks for commits, not naira', () => {
    expect(validateGoal({ ...repo, target_amount: '' })).toMatch(/commits/i)
  })

  it('refuses half a commit', () => {
    expect(validateGoal({ ...repo, target_amount: '2.5' })).toBeTruthy()
  })

  it('does not weaken the rule for money goals', () => {
    // The regression this pair exists to catch. The easy way to let repo goals
    // through is to drop the category-or-wallet requirement outright, which
    // would also let a savings goal through with nothing measuring it -- a goal
    // that then sits at 0 forever with no error anywhere. Migration 010's verify
    // block asserts the same thing in SQL.
    expect(validateGoal({ ...measured, metric_category: '', metric_wallet_id: '' })).toBeTruthy()
    expect(
      validateGoal({ ...measured, metric: 'spend_under', metric_category: '', metric_wallet_id: '' }),
    ).toBeTruthy()
  })
})

