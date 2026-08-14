import { describe, it, expect } from 'vitest'
import {
  reviewPlan,
  resolveCitation,
  planWeeks,
  PLAN_STATUS,
  MAX_PLAN_WEEKS,
} from '../src/lib/planReview.js'
import { startOfWeek, endOfMonth } from '../src/lib/queries.js'

/**
 * The gate between "a model said this" and "this is written down".
 *
 * Everything else in this app that writes to `goals` does arithmetic, and
 * arithmetic can only be wrong in ways you can see. A model can be wrong
 * fluently. This project has shipped that twice -- `enable_thinking` sent to a
 * retired model, a `MEDIUM` confidence the database always rejected -- and both
 * times the giveaway was the same: nothing checkable was attached to the claim.
 *
 * So every test here is a way of asking one question. Would this have been
 * caught?
 */

const evidence = {
  paths: ['src/lib/constants.js', 'src/lib/toast.js', 'scripts/llm.mjs'],
  gaps: [
    { id: 'g1', topic: 'PostgREST upsert semantics' },
    { id: 'g2', topic: 'React StrictMode double invoke' },
  ],
}

const item = (over = {}) => ({
  week: 1,
  focus: 'Add tests for src/lib/constants.js',
  cites: 'src/lib/constants.js',
  ...over,
})

describe('resolveCitation', () => {
  it('accepts a path copied exactly', () => {
    expect(resolveCitation('src/lib/toast.js', evidence)).toEqual({
      kind: 'path',
      value: 'src/lib/toast.js',
    })
  })

  it('refuses a path that is nearly right', () => {
    // The case that matters. A model writing `constant.js` for `constants.js`
    // has not read the list, and accepting it would mean accepting a plan about
    // a file that does not exist -- which reads exactly like a plan about one
    // that does.
    expect(resolveCitation('src/lib/constant.js', evidence)).toBe(null)
    expect(resolveCitation('lib/constants.js', evidence)).toBe(null)
    expect(resolveCitation('src/lib/', evidence)).toBe(null)
  })

  it('refuses a plausible path that simply is not there', () => {
    expect(resolveCitation('src/lib/auth.js', evidence)).toBe(null)
    expect(resolveCitation('README.md', evidence)).toBe(null)
  })

  it('accepts a gap topic, ignoring capitalisation', () => {
    // A gap topic is a sentence a person typed. Holding a model to its
    // capitalisation would reject correct citations for no benefit -- unlike a
    // path, where the exact string is the whole point.
    expect(resolveCitation('postgrest upsert semantics', evidence)).toEqual({
      kind: 'gap',
      value: 'PostgREST upsert semantics',
    })
  })

  it('refuses an empty or missing citation', () => {
    for (const cites of ['', '   ', null, undefined, 42, {}]) {
      expect(resolveCitation(cites, evidence)).toBe(null)
    }
  })

  it('refuses everything when there is no evidence at all', () => {
    // A run where the repository listing failed must draft nothing, not draft
    // freely. Failing open here would mean the one time the grounding broke is
    // the one time the model got a blank cheque.
    expect(resolveCitation('src/lib/constants.js', {})).toBe(null)
    expect(resolveCitation('src/lib/constants.js', { paths: [], gaps: [] })).toBe(null)
  })
})

describe('reviewPlan', () => {
  it('keeps an item that cites something real', () => {
    const { accepted, rejected } = reviewPlan([item()], evidence, { weeks: 4 })
    expect(rejected).toEqual([])
    expect(accepted).toHaveLength(1)
    expect(accepted[0]).toMatchObject({ week: 1, cites: 'src/lib/constants.js', kind: 'path' })
  })

  it('throws away an item that cites nothing', () => {
    const { accepted, rejected } = reviewPlan(
      [item({ focus: 'Improve code quality this week', cites: 'general best practice' })],
      evidence,
      { weeks: 4 },
    )
    expect(accepted).toEqual([])
    expect(rejected[0].reason).toMatch(/not a path in this repository or a gap you logged/)
  })

  it('rejects only the item that fails, not the plan around it', () => {
    // A plan where three of five weeks are grounded is a three-week plan. One
    // bad line must not cost the month's thinking.
    const { accepted, rejected } = reviewPlan(
      [
        item({ week: 1 }),
        item({ week: 2, cites: 'src/lib/invented.js' }),
        item({ week: 3, cites: 'PostgREST upsert semantics', focus: 'Write up what an upsert does' }),
      ],
      evidence,
      { weeks: 4 },
    )
    expect(accepted.map((a) => a.week)).toEqual([1, 3])
    expect(rejected).toHaveLength(1)
  })

  it('gives every rejection a reason in words', () => {
    // The reasons are printed by the planner script and are the only place
    // anyone sees why the model's output shrank. Without them, a run that kept
    // two of six looks identical to a model that offered two.
    const { rejected } = reviewPlan(
      [item({ week: 99 }), item({ week: 2, focus: 'x' }), item({ week: 3, cites: 'nope' })],
      evidence,
      { weeks: 4 },
    )
    expect(rejected).toHaveLength(3)
    for (const r of rejected) {
      expect(typeof r.reason).toBe('string')
      expect(r.reason.length).toBeGreaterThan(10)
    }
  })

  it('refuses a week the month does not have', () => {
    const { accepted, rejected } = reviewPlan([item({ week: 6 })], evidence, { weeks: 4 })
    expect(accepted).toEqual([])
    expect(rejected[0].reason).toMatch(/not one of the 4 weeks/)
  })

  it('refuses a second focus for the same week', () => {
    // Two suggestions for week 2 and none for week 3 is a model that lost
    // count. Silently keeping the first would hide that.
    const { accepted, rejected } = reviewPlan(
      [item({ week: 2 }), item({ week: 2, cites: 'src/lib/toast.js' })],
      evidence,
      { weeks: 4 },
    )
    expect(accepted).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/already has a focus/)
  })

  it('refuses a focus too short to act on, or too long to read', () => {
    expect(reviewPlan([item({ focus: 'Tests' })], evidence).rejected).toHaveLength(1)
    expect(reviewPlan([item({ focus: 'x'.repeat(300) })], evidence).rejected).toHaveLength(1)
  })

  it('returns the weeks in order, whatever order they arrived in', () => {
    const { accepted } = reviewPlan(
      [item({ week: 3 }), item({ week: 1, cites: 'src/lib/toast.js' }), item({ week: 2, cites: 'scripts/llm.mjs' })],
      evidence,
      { weeks: 4 },
    )
    expect(accepted.map((a) => a.week)).toEqual([1, 2, 3])
  })

  it('accepts an empty plan as an answer', () => {
    // "Nothing in the inputs supports a plan" is a legitimate reply and the
    // prompt asks for it explicitly. Treating it as a failure would push the
    // model toward filler, which is the one thing the citation rule cannot
    // catch -- filler that cites a real path passes.
    expect(reviewPlan([], evidence)).toEqual({ accepted: [], rejected: [] })
  })

  it('survives junk instead of a plan', () => {
    for (const junk of [null, undefined, 'weeks', { weeks: 1 }, [null, 3, 'x']]) {
      const result = reviewPlan(junk, evidence)
      expect(result.accepted).toEqual([])
      expect(Array.isArray(result.rejected)).toBe(true)
    }
  })

  it('never accepts more weeks than a month can hold', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      item({ week: i + 1, cites: 'src/lib/toast.js', focus: `Work on thing number ${i + 1}` }),
    )
    const { accepted } = reviewPlan(many, evidence, { weeks: 99 })
    expect(accepted.length).toBeLessThanOrEqual(MAX_PLAN_WEEKS)
  })
})

describe('planWeeks', () => {
  it('starts on the Monday of the week containing the 1st', () => {
    // 1 August 2026 is a Saturday, so the first week of the plan starts on
    // Monday 27 July. That is correct rather than sloppy: it is a real week,
    // and truncating it to start on the 1st would leave a two-day week the
    // arithmetic then divides by seven.
    const weeks = planWeeks('2026-08-01', startOfWeek, endOfMonth)
    expect(weeks[0]).toBe('2026-07-27')
  })

  it('covers the whole month and stops', () => {
    const weeks = planWeeks('2026-08-01', startOfWeek, endOfMonth)
    expect(weeks).toEqual(['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'])
  })

  it('handles a month that starts on a Monday', () => {
    // June 2026 starts on a Monday, so there is no leading part-week.
    const weeks = planWeeks('2026-06-01', startOfWeek, endOfMonth)
    expect(weeks[0]).toBe('2026-06-01')
    expect(weeks.length).toBeLessThanOrEqual(MAX_PLAN_WEEKS)
  })

  it('returns nothing for junk rather than looping', () => {
    expect(planWeeks(null, startOfWeek, endOfMonth)).toEqual([])
    expect(planWeeks('sometime', startOfWeek, endOfMonth)).toEqual([])
  })
})

describe('PLAN_STATUS', () => {
  it('matches the values migration 011 will accept', () => {
    // A mismatch here is a 23514 at write time, naming a constraint and
    // explaining nothing -- the same shape as the MEDIUM confidence outage.
    expect(Object.values(PLAN_STATUS).sort()).toEqual(['active', 'discarded', 'draft'])
  })
})
