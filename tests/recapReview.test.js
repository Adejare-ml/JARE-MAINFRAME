import { describe, it, expect } from 'vitest'
import {
  reviewRecap,
  resolveFactCitation,
  MIN_SENTENCE,
  MAX_SENTENCE,
  DEFAULT_MAX_SENTENCES,
} from '../src/lib/recapReview.js'

/**
 * The gate between "a model said this about your money" and "this is shown on
 * screen". Every test here asks one question, same as planReview.test.js's:
 * would a wrong number have been caught?
 */

const facts = [
  { key: 'spent', numbers: [45231.5, 40384, 12], text: 'Spent ₦45,231.50 this week, up 12% from ₦40,384.00 last week.' },
  { key: 'category:Transport', numbers: [8000], text: 'Transport came to ₦8,000.00 this week.' },
  { key: 'streak', numbers: [3], text: '3 days logged in a row.' },
]

const item = (over = {}) => ({
  sentence: 'You spent ₦45,231.50 this week, up 12% on last week.',
  cites: 'spent',
  ...over,
})

describe('resolveFactCitation', () => {
  it('accepts a key copied exactly', () => {
    expect(resolveFactCitation('spent', facts)).toBe(facts[0])
  })

  it('refuses a key that is nearly right', () => {
    expect(resolveFactCitation('Spent', facts)).toBe(null)
    expect(resolveFactCitation('spending', facts)).toBe(null)
  })

  it('refuses a plausible key that simply is not there', () => {
    expect(resolveFactCitation('category:Feeding', facts)).toBe(null)
    expect(resolveFactCitation('income', facts)).toBe(null)
  })

  it('refuses an empty or missing citation', () => {
    for (const cites of ['', '   ', null, undefined, 42, {}]) {
      expect(resolveFactCitation(cites, facts)).toBe(null)
    }
  })

  it('refuses everything when there are no facts at all', () => {
    expect(resolveFactCitation('spent', [])).toBe(null)
    expect(resolveFactCitation('spent', undefined)).toBe(null)
  })
})

describe('reviewRecap', () => {
  it('keeps a sentence that cites a real fact and matches its numbers', () => {
    const { accepted, rejected } = reviewRecap([item()], facts)
    expect(rejected).toEqual([])
    expect(accepted).toEqual([{ sentence: item().sentence, cites: 'spent' }])
  })

  it('throws away a sentence that cites nothing real', () => {
    const { accepted, rejected } = reviewRecap(
      [item({ cites: 'overall vibe' })],
      facts,
    )
    expect(accepted).toEqual([])
    expect(rejected[0].reason).toMatch(/not one of this week's facts/)
  })

  it('catches a real citation paired with an invented number', () => {
    // The failure mode this file exists to catch that planReview.js never had
    // to: the citation is real, but the figure next to it is not.
    const { accepted, rejected } = reviewRecap(
      [item({ sentence: 'You spent ₦52,000.00 this week, way more than usual.' })],
      facts,
    )
    expect(accepted).toEqual([])
    expect(rejected[0].reason).toMatch(/52000, which is not one of the numbers spent actually has/)
  })

  it('accepts a number written with different punctuation, same digits', () => {
    const { accepted } = reviewRecap(
      [item({ sentence: 'Spent 45231.50 this week, a 12 percent jump on last week.' })],
      facts,
    )
    expect(accepted).toHaveLength(1)
  })

  it('rejects only the sentence that fails, not the recap around it', () => {
    const { accepted, rejected } = reviewRecap(
      [
        item({ cites: 'spent' }),
        item({ sentence: 'Transport ran to ₦9,999.00 this week.', cites: 'category:Transport' }),
        item({ sentence: 'You kept a 3 day streak going.', cites: 'streak' }),
      ],
      facts,
    )
    expect(accepted.map((a) => a.cites)).toEqual(['spent', 'streak'])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/9999/)
  })

  it('gives every rejection a reason in words', () => {
    const { rejected } = reviewRecap(
      [item({ cites: 'nope' }), item({ sentence: 'x' }), item({ sentence: 'Spent ₦999,999.00 today.' })],
      facts,
    )
    expect(rejected).toHaveLength(3)
    for (const r of rejected) {
      expect(typeof r.reason).toBe('string')
      expect(r.reason.length).toBeGreaterThan(5)
    }
  })

  it('refuses a second sentence about the same fact', () => {
    const { accepted, rejected } = reviewRecap(
      [item({ cites: 'streak', sentence: 'You kept a 3 day streak going this week.' }),
       item({ cites: 'streak', sentence: 'That is 3 days logged in a row, nice work.' })],
      facts,
    )
    expect(accepted).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/streak already has a sentence/)
  })

  it('refuses a sentence too short to say anything, or too long to read', () => {
    expect(reviewRecap([item({ sentence: 'Spent it.' })], facts).rejected).toHaveLength(1)
    expect(reviewRecap([item({ sentence: 'x'.repeat(300) })], facts).rejected).toHaveLength(1)
    expect(MIN_SENTENCE).toBeLessThan(MAX_SENTENCE)
  })

  it('caps the recap at the sentence limit even with a distinct fact for each sentence', () => {
    const three = [
      item({ cites: 'spent', sentence: 'You spent ₦45,231.50 this week, up 12% on last week.' }),
      item({ cites: 'category:Transport', sentence: 'Transport came to ₦8,000.00 this week.' }),
      item({ cites: 'streak', sentence: 'You kept a 3 day streak going this week.' }),
    ]
    const { accepted, rejected } = reviewRecap(three, facts, { maxSentences: 2 })
    expect(accepted).toHaveLength(2)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/already has 2 sentences/)
  })

  it('defaults to a small sentence cap', () => {
    expect(DEFAULT_MAX_SENTENCES).toBeGreaterThan(0)
    expect(DEFAULT_MAX_SENTENCES).toBeLessThanOrEqual(10)
  })

  it('accepts an empty recap as an answer', () => {
    expect(reviewRecap([], facts)).toEqual({ accepted: [], rejected: [] })
  })

  it('survives junk instead of a recap', () => {
    for (const junk of [null, undefined, 'sentences', { sentences: 1 }, [null, 3, 'x']]) {
      const result = reviewRecap(junk, facts)
      expect(result.accepted).toEqual([])
      expect(Array.isArray(result.rejected)).toBe(true)
    }
  })

  it('refuses everything when there are no facts to cite', () => {
    const { accepted, rejected } = reviewRecap([item()], [])
    expect(accepted).toEqual([])
    expect(rejected).toHaveLength(1)
  })
})
