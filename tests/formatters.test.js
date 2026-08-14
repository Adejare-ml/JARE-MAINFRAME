import { describe, it, expect } from 'vitest'
import { formatGoalAmount, formatNaira } from '../src/lib/formatters.js'

/**
 * Until goals started counting commits, every figure in this app was money and
 * the currency symbol could be hardcoded. It cannot any more.
 *
 * Rendering "₦3.00" where the goal means three commits is not a cosmetic slip.
 * It is the app stating a number in a unit that makes it false, on the one
 * screen whose entire job is to be checkable by hand.
 */
describe('formatGoalAmount', () => {
  it('counts commits in commits', () => {
    expect(formatGoalAmount(3, 'repo_commits')).toBe('3 commits')
  })

  it('says "1 commit", not "1 commits"', () => {
    expect(formatGoalAmount(1, 'repo_commits')).toBe('1 commit')
  })

  it('says "0 commits" for a day with nothing on it', () => {
    // Reached often -- a checked-and-empty day is a normal outcome, not an
    // error state, so it has to read as an ordinary sentence.
    expect(formatGoalAmount(0, 'repo_commits')).toBe('0 commits')
  })

  it('never shows a fraction of a commit', () => {
    // `pace` rounds up and the form refuses a fractional target, so this should
    // not arise -- but a "2.5 commits" reaching the screen would be the app
    // showing its arithmetic leaking rather than its answer.
    expect(formatGoalAmount(2.4, 'repo_commits')).toBe('2 commits')
  })

  it('falls through to naira for every money metric', () => {
    // Written as a comparison rather than a literal so a change to formatNaira
    // cannot leave the two disagreeing about what money looks like.
    for (const metric of ['save_at_least', 'spend_under', 'manual', undefined]) {
      expect(formatGoalAmount(150000, metric)).toBe(formatNaira(150000))
    }
  })

  it('survives junk instead of a number', () => {
    expect(formatGoalAmount(null, 'repo_commits')).toBe('0 commits')
    expect(formatGoalAmount('abc', 'repo_commits')).toBe('0 commits')
  })
})
