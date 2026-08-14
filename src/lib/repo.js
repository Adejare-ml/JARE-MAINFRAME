/**
 * Which commits count as work on which day.
 *
 * This is the whole of the repo verifier's judgment, kept apart from the code
 * that talks to GitHub and to Supabase so it can be tested without either. The
 * script in scripts/verify-repo.mjs is then just wiring: fetch, call these,
 * write.
 *
 * The one genuinely hard thing here is the date.
 *
 * A commit carries an instant, not a day. Deciding which day it belongs to
 * means picking a timezone, and the obvious choice -- whatever the machine
 * thinks -- is wrong twice over: the verifier runs on a GitHub runner, which is
 * UTC, and the person whose day is being judged is in Lagos. A commit pushed at
 * 00:30 on Tuesday in Lagos is 23:30 Monday in UTC, so the naive version credits
 * it to the wrong day and reports Tuesday as a day with nothing on it.
 *
 * That is not a hypothetical. The same off-by-one already happened in this app
 * with `transaction_date`: Daily HQ loaded yesterday's priorities between
 * midnight and 1am Lagos until every date helper in queries.js was moved to
 * local time. So the offset is explicit here, passed in rather than read from
 * the environment, and every function that turns an instant into a day takes it.
 */

/**
 * Lagos is UTC+1 all year -- Nigeria has observed no daylight saving since
 * 1980, so a fixed offset is correct rather than merely convenient. Overridable
 * so this module does not have to be edited if that ever stops being true, or
 * if someone runs it from somewhere else.
 */
export const LAGOS_OFFSET_MINUTES = 60

/** Longest commit subject kept in evidence. Enough to recognise, not a diff. */
const MAX_MESSAGE_LENGTH = 120

/**
 * GitHub's commit object, reduced to the fields any of this cares about.
 *
 * Done once, at the edge, so the rules below read as rules rather than as
 * `c.commit.author.date` five times. It also means a test can write a commit
 * out by hand in three fields instead of imitating an API response.
 *
 * `commit.author.date` rather than `commit.committer.date`: the author date is
 * when the work was written, which is the question being asked. A rebase moves
 * the committer date and would silently relocate a week of work to the day it
 * was rebased. GitHub's own `since`/`until` filter on the committer date
 * instead, which is why utcWindow takes a margin -- see the note there.
 *
 * @param {object} raw - an item from GET /repos/{owner}/{repo}/commits
 * @returns {{sha: string, message: string, at: string, login: string|null, email: string|null, parents: number}|null}
 */
export function normalizeCommit(raw) {
  if (!raw || !raw.sha) return null
  const commit = raw.commit || {}
  const author = commit.author || {}

  return {
    sha: raw.sha,
    message: firstLine(commit.message),
    at: author.date || commit.committer?.date || null,
    login: raw.author?.login || null,
    email: author.email || null,
    parents: Array.isArray(raw.parents) ? raw.parents.length : 1,
  }
}

function firstLine(message) {
  const line = String(message || '').split('\n')[0].trim()
  return line.length > MAX_MESSAGE_LENGTH ? `${line.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : line
}

/**
 * The calendar day an instant falls on, at a fixed offset from UTC.
 *
 * Shifting the instant and then reading the UTC date off it is the whole trick:
 * `toISOString` always formats in UTC, so an instant moved forward by the
 * offset formats as the wall-clock date at that offset.
 *
 * @param {string} iso - any parseable timestamp
 * @param {number} [offsetMinutes] - minutes east of UTC
 * @returns {string|null} YYYY-MM-DD, or null if the timestamp is unusable
 */
export function localDate(iso, offsetMinutes = LAGOS_OFFSET_MINUTES) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return new Date(t + offsetMinutes * 60000).toISOString().slice(0, 10)
}

/**
 * The UTC instants that bound a range of local days, for the API's `since` and
 * `until`.
 *
 * The mirror image of localDate, and needed for the same reason: asking GitHub
 * for commits `since` midnight UTC on the 14th misses everything committed
 * between midnight and 1am Lagos on the 14th -- exactly the commits the naive
 * date arithmetic would also have misfiled. Getting one right and not the other
 * would leave the bug in place with more code around it.
 *
 * `until` is the last millisecond of the last day, not the start of the next
 * one, because GitHub's range is inclusive on both ends.
 *
 * `marginDays` widens the request without widening the answer, and exists for a
 * mismatch that is easy to miss: GitHub filters `since`/`until` on the
 * COMMITTER date, while `localDate` buckets on the AUTHOR date. The two are
 * identical for a squash merge -- GitHub sets both to the merge instant -- but
 * a commit written at 23:50 and pushed after midnight has a committer date one
 * day later than its author date, and an exact request would drop it. A day of
 * slack costs one extra page of results and closes that edge; the commits it
 * drags in are then filtered out by commitsInWindow, which works on author
 * dates and is the thing that actually decides.
 *
 * @param {{from: string, to: string, offsetMinutes?: number, marginDays?: number}} range
 * @returns {{since: string, until: string}} ISO instants
 */
export function utcWindow({ from, to, offsetMinutes = LAGOS_OFFSET_MINUTES, marginDays = 0 }) {
  const shift = offsetMinutes * 60000
  const margin = Math.max(0, marginDays) * 86400000

  return {
    since: new Date(Date.parse(`${from}T00:00:00.000Z`) - shift - margin).toISOString(),
    until: new Date(Date.parse(`${to}T23:59:59.999Z`) - shift + margin).toISOString(),
  }
}

/**
 * Is this commit work by the person the goal is about?
 *
 * Two filters, both of which default to letting everything through, because a
 * verifier that silently counts nothing is worse than one that counts too much:
 * an empty result would read as "you did nothing this week" rather than as
 * "this is misconfigured".
 *
 * **Merges do not count.** A merge commit is the act of combining work, not the
 * work. This repository squash-merges, so a merged pull request arrives as one
 * ordinary commit and nothing is lost by excluding true merges -- but on a
 * repository that merges normally, counting both the branch's commits and the
 * merge would inflate every figure by the number of pull requests.
 *
 * **The author filter is optional**, and matches a GitHub login or a commit
 * email, case-insensitively. Unset means a single-person repository where every
 * commit is yours.
 *
 * @param {object} commit - a normalized commit
 * @param {{author?: string}} [options]
 */
export function countsAsWork(commit, { author } = {}) {
  if (!commit) return false
  if (commit.parents > 1) return false
  if (!author) return true

  const wanted = String(author).toLowerCase()
  return (
    String(commit.login || '').toLowerCase() === wanted ||
    String(commit.email || '').toLowerCase() === wanted
  )
}

/**
 * Group the commits that count by the local day they landed on.
 *
 * @param {Array<object>} commits - normalized commits
 * @param {{author?: string, offsetMinutes?: number}} [options]
 * @returns {Map<string, Array<object>>} YYYY-MM-DD -> commits, newest first
 */
export function commitsByDay(commits, { author, offsetMinutes = LAGOS_OFFSET_MINUTES } = {}) {
  const byDay = new Map()

  for (const commit of commits || []) {
    if (!countsAsWork(commit, { author })) continue
    const day = localDate(commit.at, offsetMinutes)
    if (!day) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(commit)
  }

  for (const list of byDay.values()) list.sort((a, b) => (a.at < b.at ? 1 : -1))
  return byDay
}

/**
 * Everything that counts within an inclusive range of local days.
 *
 * @param {Map<string, Array<object>>} byDay - from commitsByDay
 * @param {{from: string, to: string}} window
 * @returns {Array<object>} normalized commits, newest first
 */
export function commitsInWindow(byDay, { from, to }) {
  const out = []
  for (const [day, list] of byDay) {
    if (day >= from && day <= to) out.push(...list)
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1))
}

/**
 * What gets written to `goals.evidence`.
 *
 * A count and nothing else would be unauditable; a boolean would be worse.
 * The window is included because a figure without the question it answers
 * cannot be checked -- "3 commits" is not a claim until it says three commits
 * where, and between when and when.
 *
 * @param {Array<object>} commits - normalized commits inside the window
 * @param {{repo: string, from: string, to: string}} context
 * @returns {{repo: string, from: string, to: string, counted: number, commits: Array<object>}}
 */
export function buildEvidence(commits, { repo, from, to }) {
  const list = commits || []
  return {
    repo,
    from,
    to,
    counted: list.length,
    commits: list.map((c) => ({ sha: c.sha, message: c.message, at: c.at })),
  }
}
