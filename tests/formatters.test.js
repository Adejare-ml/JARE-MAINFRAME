import { describe, it, expect } from 'vitest'
import { formatGoalAmount, formatNaira, displayName } from '../src/lib/formatters.js'

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

describe('displayName', () => {
  it('prefers a first name from the account metadata', () => {
    expect(displayName({ user_metadata: { name: 'Adejare Adelugba' } })).toBe('Adejare')
    expect(displayName({ user_metadata: { full_name: 'Ade Lugba' }, email: 'x@y.z' })).toBe('Ade')
  })

  it('falls back to the email, capitalised and cut at the first separator', () => {
    expect(displayName({ email: 'adejare.adelugba@gmail.com' })).toBe('Adejare')
    expect(displayName({ email: 'ade_l@x.com' })).toBe('Ade')
  })

  it('still has something to say for nobody at all', () => {
    expect(displayName(null)).toBe('there')
    expect(displayName({})).toBe('there')
  })
})

import {
  formatNairaSigned,
  formatNairaWhole,
  formatNairaCompact,
  formatRailTime,
  shortAge,
  MINUS,
} from '../src/lib/formatters.js'

describe('formatNairaSigned', () => {
  it('shows kobo by default and a real minus sign for negatives', () => {
    expect(formatNairaSigned(5808.09)).toBe('₦5,808.09')
    expect(formatNairaSigned(-2500)).toBe(`${MINUS}₦2,500.00`)
    expect(MINUS).toBe('−')
  })

  it('adds a plus only when asked, never to zero', () => {
    expect(formatNairaSigned(12000, { sign: true })).toBe('+₦12,000.00')
    expect(formatNairaSigned(0, { sign: true })).toBe('₦0.00')
  })

  it('drops kobo when asked', () => {
    expect(formatNairaSigned(1234.56, { kobo: false })).toBe('₦1,235')
  })

  it('treats junk as zero', () => {
    expect(formatNairaSigned(null)).toBe('₦0.00')
    expect(formatNairaSigned('abc', { kobo: false })).toBe('₦0')
  })
})

describe('formatNairaWhole', () => {
  it('rounds to whole naira with grouping', () => {
    expect(formatNairaWhole(1234567.89)).toBe('₦1,234,568')
    expect(formatNairaWhole(-499.5)).toBe(`${MINUS}₦500`)
    expect(formatNairaWhole(0)).toBe('₦0')
  })
})

describe('formatNairaCompact', () => {
  it('compacts billions, millions and thousands, trimming zeros', () => {
    expect(formatNairaCompact(1234567890)).toBe('₦1.23B')
    expect(formatNairaCompact(1200000000)).toBe('₦1.2B')
    expect(formatNairaCompact(4500000)).toBe('₦4.5M')
    expect(formatNairaCompact(12345)).toBe('₦12.34K')
    expect(formatNairaCompact(950)).toBe('₦950')
  })

  it('never rounds up past what is there', () => {
    expect(formatNairaCompact(1999999999)).toBe('₦1.99B')
  })

  it('signs negatives with U+2212', () => {
    expect(formatNairaCompact(-2500000000)).toBe(`${MINUS}₦2.5B`)
  })
})

describe('formatRailTime', () => {
  const now = new Date(2026, 10, 27, 15, 0)
  it('shows HH:mm for today', () => {
    expect(formatRailTime(new Date(2026, 10, 27, 9, 14), now)).toBe('09:14')
  })
  it('says Yesterday with the time', () => {
    expect(formatRailTime(new Date(2026, 10, 26, 21, 40), now)).toBe('Yesterday 21:40')
  })
  it('counts days beyond that', () => {
    expect(formatRailTime(new Date(2026, 10, 25, 8, 0), now)).toBe('2d ago')
  })
  it('is empty for nothing', () => {
    expect(formatRailTime(null, now)).toBe('')
    expect(formatRailTime('nope', now)).toBe('')
  })
})

describe('shortAge', () => {
  const now = new Date(2026, 10, 27, 15, 0)
  it('uses hours under two days and days after', () => {
    expect(shortAge(new Date(2026, 10, 27, 10, 0), now)).toBe('5h')
    expect(shortAge(new Date(2026, 10, 25, 15, 0), now)).toBe('2d')
  })
})
