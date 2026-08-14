import { describe, it, expect } from 'vitest'
import {
  normalizeCommit,
  localDate,
  utcWindow,
  countsAsWork,
  commitsByDay,
  commitsInWindow,
  buildEvidence,
  LAGOS_OFFSET_MINUTES,
} from '../src/lib/repo.js'

/**
 * A commit carries an instant. A goal is about a day. Every test here is about
 * the gap between the two, because that gap has already produced one real bug in
 * this app: Daily HQ loaded yesterday's priorities between midnight and 1am
 * Lagos, for exactly as long as its date helpers ran in UTC.
 *
 * The verifier runs on a GitHub runner, which is UTC, about a person who is in
 * Lagos. So the naive version is wrong by an hour every night, and wrong in the
 * direction that reports a day of work as an empty one.
 */

/** 00:30 on Tuesday 11 August 2026 in Lagos -- 23:30 Monday in UTC. */
const JUST_AFTER_MIDNIGHT = '2026-08-10T23:30:00Z'

/** 23:30 on Monday 10 August 2026 in Lagos -- 22:30 the same day in UTC. */
const LATE_THE_NIGHT_BEFORE = '2026-08-10T22:30:00Z'

const commit = (over = {}) => ({
  sha: 'aaaaaaa1',
  message: 'do the thing',
  at: '2026-08-10T12:00:00Z',
  login: 'adejare-ml',
  email: 'adejare@example.com',
  parents: 1,
  ...over,
})

describe('localDate', () => {
  it('credits a commit made just after midnight in Lagos to that day', () => {
    // The whole reason this function exists. In UTC this instant is the 10th,
    // and reading it that way reports Tuesday as a day with nothing on it while
    // the work sits on Monday's pile.
    expect(localDate(JUST_AFTER_MIDNIGHT, LAGOS_OFFSET_MINUTES)).toBe('2026-08-11')
  })

  it('leaves a commit made late the previous evening where it belongs', () => {
    expect(localDate(LATE_THE_NIGHT_BEFORE, LAGOS_OFFSET_MINUTES)).toBe('2026-08-10')
  })

  it('agrees with UTC when the offset is zero', () => {
    expect(localDate(JUST_AFTER_MIDNIGHT, 0)).toBe('2026-08-10')
  })

  it('handles an offset west of UTC', () => {
    // Nothing here is Lagos-specific; the offset is a parameter for a reason.
    expect(localDate('2026-08-11T02:00:00Z', -300)).toBe('2026-08-10')
  })

  it('returns null rather than "Invalid Date" for an unusable timestamp', () => {
    expect(localDate(undefined)).toBe(null)
    expect(localDate('not a date')).toBe(null)
  })
})

describe('utcWindow', () => {
  it('starts an hour before midnight UTC, so the first Lagos hour is included', () => {
    // The mirror image of the bug above: asking GitHub for commits since
    // midnight UTC on the 11th misses everything written between midnight and
    // 1am Lagos -- the very commits localDate was fixed to place correctly.
    const { since } = utcWindow({ from: '2026-08-11', to: '2026-08-11' })
    expect(since).toBe('2026-08-10T23:00:00.000Z')
  })

  it('ends on the last millisecond of the last local day', () => {
    const { until } = utcWindow({ from: '2026-08-11', to: '2026-08-11' })
    expect(until).toBe('2026-08-11T22:59:59.999Z')
  })

  it('adds no slack unless asked', () => {
    const exact = utcWindow({ from: '2026-08-11', to: '2026-08-11' })
    const slack = utcWindow({ from: '2026-08-11', to: '2026-08-11', marginDays: 1 })
    expect(slack.since).toBe('2026-08-09T23:00:00.000Z')
    expect(slack.until).toBe('2026-08-12T22:59:59.999Z')
    expect(exact.since).not.toBe(slack.since)
  })

  it('widens the request for the committer-vs-author date mismatch', () => {
    // GitHub filters since/until on the COMMITTER date; localDate buckets on
    // the AUTHOR date. A commit written at 23:50 and pushed after midnight has
    // a committer date a day later than its author date, so an exact request
    // drops it -- and the day it belongs to reads as empty. The margin catches
    // it; commitsInWindow, which works on author dates, still decides.
    const authored = '2026-08-11T22:50:00Z'   // 23:50 Lagos on the 11th
    const pushed = '2026-08-12T00:10:00Z'     // 01:10 Lagos on the 12th

    const exact = utcWindow({ from: '2026-08-11', to: '2026-08-11' })
    expect(pushed > exact.until).toBe(true)

    const slack = utcWindow({ from: '2026-08-11', to: '2026-08-11', marginDays: 1 })
    expect(pushed < slack.until).toBe(true)
    expect(localDate(authored)).toBe('2026-08-11')
  })

  it('brackets exactly the days it was asked for', () => {
    // Stated as a round trip rather than as two literals, because the two
    // functions have to agree and asserting the strings separately would let
    // them drift apart while both tests still passed.
    const { since, until } = utcWindow({ from: '2026-08-11', to: '2026-08-13' })
    expect(localDate(since)).toBe('2026-08-11')
    expect(localDate(until)).toBe('2026-08-13')
    expect(localDate(new Date(Date.parse(since) - 1).toISOString())).toBe('2026-08-10')
    expect(localDate(new Date(Date.parse(until) + 1).toISOString())).toBe('2026-08-14')
  })
})

describe('countsAsWork', () => {
  it('counts an ordinary commit when no author is configured', () => {
    // Defaulting to "everything counts" on purpose: a filter that matches
    // nothing would report an empty week rather than a misconfiguration.
    expect(countsAsWork(commit())).toBe(true)
  })

  it('does not count a merge', () => {
    // Combining work is not the work. On a repository that merges rather than
    // squashes, counting the merge as well as the branch inflates every figure
    // by the number of pull requests.
    expect(countsAsWork(commit({ parents: 2 }))).toBe(false)
  })

  it('matches an author by login or email, ignoring case', () => {
    expect(countsAsWork(commit(), { author: 'Adejare-ML' })).toBe(true)
    expect(countsAsWork(commit(), { author: 'ADEJARE@example.com' })).toBe(true)
  })

  it('rejects somebody else', () => {
    expect(countsAsWork(commit(), { author: 'dependabot[bot]' })).toBe(false)
  })

  it('still matches by email when GitHub has no account to attach', () => {
    // `author` is null for a commit whose email is not on any GitHub account,
    // which is normal and must not silently drop the commit.
    expect(countsAsWork(commit({ login: null }), { author: 'adejare@example.com' })).toBe(true)
  })
})

describe('commitsByDay', () => {
  it('splits a night across two days at the Lagos boundary, not the UTC one', () => {
    const byDay = commitsByDay([
      commit({ sha: 'late', at: LATE_THE_NIGHT_BEFORE }),
      commit({ sha: 'early', at: JUST_AFTER_MIDNIGHT }),
    ])

    expect(byDay.get('2026-08-10').map((c) => c.sha)).toEqual(['late'])
    expect(byDay.get('2026-08-11').map((c) => c.sha)).toEqual(['early'])
  })

  it('has no entry for a day with nothing on it', () => {
    // Absent rather than zero. "No commits that day" is not this function's
    // conclusion to draw -- whether that means anything depends on whether the
    // check ran at all, which only `verified_at` knows.
    const byDay = commitsByDay([commit()])
    expect(byDay.has('2026-08-09')).toBe(false)
  })

  it('leaves out merges and other people', () => {
    const byDay = commitsByDay(
      [commit({ sha: 'mine' }), commit({ sha: 'merge', parents: 2 }), commit({ sha: 'theirs', login: 'someone', email: 'someone@example.com' })],
      { author: 'adejare-ml' },
    )
    expect(byDay.get('2026-08-10').map((c) => c.sha)).toEqual(['mine'])
  })

  it('survives commits with no usable timestamp', () => {
    const byDay = commitsByDay([commit({ at: null }), commit({ sha: 'ok' })])
    expect([...byDay.values()].flat().map((c) => c.sha)).toEqual(['ok'])
  })
})

describe('commitsInWindow', () => {
  const byDay = commitsByDay([
    commit({ sha: 'before', at: '2026-08-09T12:00:00Z' }),
    commit({ sha: 'first', at: '2026-08-10T12:00:00Z' }),
    commit({ sha: 'last', at: '2026-08-12T12:00:00Z' }),
    commit({ sha: 'after', at: '2026-08-13T12:00:00Z' }),
  ])

  it('includes both ends of the range', () => {
    // A goal due on the 12th can still be worked on during the 12th. Counting
    // exclusively is how a week quietly loses its last day.
    const found = commitsInWindow(byDay, { from: '2026-08-10', to: '2026-08-12' })
    expect(found.map((c) => c.sha).sort()).toEqual(['first', 'last'])
  })

  it('returns nothing for a window with no commits in it', () => {
    expect(commitsInWindow(byDay, { from: '2026-07-01', to: '2026-07-31' })).toEqual([])
  })

  it('returns a single day when asked for one', () => {
    const found = commitsInWindow(byDay, { from: '2026-08-10', to: '2026-08-10' })
    expect(found.map((c) => c.sha)).toEqual(['first'])
  })
})

describe('buildEvidence', () => {
  it('records the commits, not just how many', () => {
    // The app is asserting something the browser cannot recompute, so it has to
    // be able to show its working -- the same rule that puts `source` on
    // goalProgress and `direction_source` on transactions.
    const evidence = buildEvidence([commit({ sha: 'abc1234', message: 'ship it' })], {
      repo: 'owner/name',
      from: '2026-08-10',
      to: '2026-08-10',
    })

    expect(evidence.counted).toBe(1)
    expect(evidence.commits).toEqual([
      { sha: 'abc1234', message: 'ship it', at: '2026-08-10T12:00:00Z' },
    ])
  })

  it('records the question it answered, not only the answer', () => {
    // "3 commits" is not a claim until it says three commits where, and between
    // when and when. Without the window it cannot be checked by hand.
    const evidence = buildEvidence([], { repo: 'owner/name', from: '2026-08-01', to: '2026-08-31' })
    expect(evidence).toMatchObject({ repo: 'owner/name', from: '2026-08-01', to: '2026-08-31' })
  })

  it('reports an empty window as counted zero rather than as nothing', () => {
    // Written down deliberately: a stored zero with a `verified_at` beside it is
    // how "somebody looked and found nothing" is told apart from "nobody
    // looked". Returning null here would collapse the two.
    expect(buildEvidence([], { repo: 'r', from: 'a', to: 'b' }).counted).toBe(0)
  })
})

describe('normalizeCommit', () => {
  const raw = {
    sha: 'deadbeef',
    commit: {
      message: 'Fix the thing\n\nWith a long body that nobody wants in a jsonb column.',
      author: { name: 'Adejare', email: 'adejare@example.com', date: '2026-08-10T09:00:00Z' },
      committer: { date: '2026-08-20T09:00:00Z' },
    },
    author: { login: 'adejare-ml' },
    parents: [{ sha: 'parent1' }],
  }

  it('keeps the author date, not the committer date', () => {
    // A rebase rewrites the committer date. Reading that one would relocate a
    // week of work to the afternoon it was rebased.
    expect(normalizeCommit(raw).at).toBe('2026-08-10T09:00:00Z')
  })

  it('keeps only the subject line', () => {
    expect(normalizeCommit(raw).message).toBe('Fix the thing')
  })

  it('truncates a subject nobody would read anyway', () => {
    const long = { ...raw, commit: { ...raw.commit, message: 'x'.repeat(400) } }
    expect(normalizeCommit(long).message.length).toBeLessThanOrEqual(120)
  })

  it('counts parents so merges can be spotted', () => {
    expect(normalizeCommit(raw).parents).toBe(1)
    expect(normalizeCommit({ ...raw, parents: [{}, {}] }).parents).toBe(2)
  })

  it('ignores anything without a sha', () => {
    expect(normalizeCommit(null)).toBe(null)
    expect(normalizeCommit({})).toBe(null)
  })

  it('does not fall over on a commit with no GitHub account attached', () => {
    const anonymous = { ...raw, author: null }
    expect(normalizeCommit(anonymous).login).toBe(null)
    expect(normalizeCommit(anonymous).email).toBe('adejare@example.com')
  })
})
