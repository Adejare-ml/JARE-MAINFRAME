/**
 * Deciding which of a model's suggestions are allowed to become drafts.
 *
 * The rule this file enforces, in one sentence: **a suggestion that cannot cite
 * something checkable does not get written down.**
 *
 * That is a stronger position than it first looks. It throws away suggestions
 * that are perfectly reasonable -- "spend a week on system design" might be
 * excellent advice -- purely because nothing in the repository or in the gaps
 * you logged makes it *this* month's advice rather than any month's. The trade
 * is deliberate. Generic advice is exactly what a model produces when it has
 * nothing to go on, and it is indistinguishable, in the output, from advice it
 * derived from your actual code. Requiring a citation is the only test that
 * separates them, because a fabricated path fails it and a real one does not.
 *
 * This project has shipped two model behaviours that could never have worked
 * and looked fine for weeks -- `enable_thinking` sent to a model that had been
 * retired, and a `MEDIUM` confidence the database always rejected. Neither had
 * anything checkable attached to it. That is the failure mode being designed
 * against.
 *
 * Pure, and importing nothing, so every rule below can be tested without a
 * model, a database or a network.
 */

/** Statuses a goal row's `plan_status` may hold. Mirrors migration 011. */
export const PLAN_STATUS = {
  ACTIVE: 'active',
  DRAFT: 'draft',
  DISCARDED: 'discarded',
}

/** Shortest and longest a focus may be. Below, it says nothing; above, nobody reads it. */
const MIN_FOCUS = 12
const MAX_FOCUS = 160

/**
 * Most weeks a plan may cover.
 *
 * A month is at most six calendar weeks by the Monday-anchored reckoning this
 * app uses (a 31-day month starting on a Sunday). Anything past that is the
 * model planning a month that does not exist.
 */
export const MAX_PLAN_WEEKS = 6

/**
 * What a proposal is allowed to point at.
 *
 * @typedef {{paths?: Array<string>, gaps?: Array<{id?: string, topic: string}>}} Evidence
 */

/**
 * Does this citation name something real?
 *
 * Exact match, not fuzzy. A near-miss is the interesting case and it must fail:
 * a model that writes `src/lib/constant.js` for `src/lib/constants.js` has not
 * read the list, and accepting it would mean accepting a plan about a file that
 * does not exist. The categorization prompt in this codebase already works this
 * way -- categories are copied verbatim from a list -- and it is the one prompt
 * here with a proven hit rate.
 *
 * @param {string} cites
 * @param {Evidence} evidence
 * @returns {{kind: 'path'|'gap', value: string}|null}
 */
export function resolveCitation(cites, evidence = {}) {
  const claim = typeof cites === 'string' ? cites.trim() : ''
  if (!claim) return null

  if ((evidence.paths || []).includes(claim)) return { kind: 'path', value: claim }

  // Gaps are matched case-insensitively: the topic is a sentence a person
  // typed, and holding a model to its capitalisation would reject correct
  // citations for no benefit. A path is a filename and gets no such latitude.
  const wanted = claim.toLowerCase()
  const gap = (evidence.gaps || []).find((g) => String(g?.topic || '').toLowerCase() === wanted)
  if (gap) return { kind: 'gap', value: gap.topic }

  return null
}

/**
 * Filter a model's proposed plan down to the parts that survive scrutiny.
 *
 * Never throws, and never returns a partial success as a failure: an item that
 * is rejected takes only itself with it. A plan where three of five weeks are
 * grounded is a three-week plan, not a discarded one -- discarding the lot
 * would mean one bad line costing you the whole month's thinking.
 *
 * Every rejection carries a reason in words. The reasons are printed by the
 * planner script, which is the only place anyone will ever see why the model's
 * output shrank; without them a run that quietly accepted two of six items
 * would look identical to a model that only offered two.
 *
 * @param {Array<{week: number, focus: string, cites: string}>} proposal
 * @param {Evidence} evidence
 * @param {{weeks?: number}} [options] - how many weeks the month actually has
 * @returns {{accepted: Array<object>, rejected: Array<{item: object, reason: string}>}}
 */
export function reviewPlan(proposal, evidence = {}, { weeks = MAX_PLAN_WEEKS } = {}) {
  const accepted = []
  const rejected = []
  const takenWeeks = new Set()

  const limit = Math.min(Math.max(1, Math.floor(weeks) || 1), MAX_PLAN_WEEKS)

  for (const raw of Array.isArray(proposal) ? proposal : []) {
    const item = raw && typeof raw === 'object' ? raw : {}
    const focus = typeof item.focus === 'string' ? item.focus.trim() : ''
    const week = Number(item.week)

    if (!Number.isInteger(week) || week < 1 || week > limit) {
      rejected.push({ item, reason: `week ${item.week} is not one of the ${limit} weeks in this month` })
      continue
    }

    // One focus per week. Two suggestions for week 2 and none for week 3 is a
    // model that lost count, and silently keeping the first would hide that.
    if (takenWeeks.has(week)) {
      rejected.push({ item, reason: `week ${week} already has a focus` })
      continue
    }

    if (focus.length < MIN_FOCUS) {
      rejected.push({ item, reason: 'the focus is too short to act on' })
      continue
    }
    if (focus.length > MAX_FOCUS) {
      rejected.push({ item, reason: `the focus runs to ${focus.length} characters; it has to fit on a card` })
      continue
    }

    const citation = resolveCitation(item.cites, evidence)
    if (!citation) {
      // The rule the whole file exists for. Stated in the reason exactly as it
      // is meant, because this is the rejection that will happen most and the
      // one most likely to be mistaken for a bug.
      rejected.push({
        item,
        reason: `cites "${item.cites ?? '(nothing)'}", which is not a path in this repository or a gap you logged`,
      })
      continue
    }

    takenWeeks.add(week)
    accepted.push({
      week,
      focus,
      cites: citation.value,
      kind: citation.kind,
      reason: typeof item.reason === 'string' ? item.reason.trim().slice(0, 300) : null,
    })
  }

  accepted.sort((a, b) => a.week - b.week)
  return { accepted, rejected }
}

/**
 * The Monday of each week a monthly goal covers.
 *
 * Weeks are Monday-anchored to match `startOfWeek`, and the first one is the
 * Monday of the week containing the 1st -- which may fall in the previous
 * month. That is correct rather than sloppy: a plan for the week of the 1st is
 * a plan for a real week, and truncating it to start on the 1st would produce
 * a four-day week the arithmetic then divides by seven.
 *
 * Kept here rather than in planning.js because it is about laying out a plan,
 * not about deriving a task from a goal.
 *
 * @param {string} monthStart - YYYY-MM-DD, the 1st
 * @param {(date: Date) => string} startOfWeek - injected from queries.js
 * @param {(date: Date) => string} endOfMonth - injected from queries.js
 * @returns {Array<string>} Monday dates, in order
 */
export function planWeeks(monthStart, startOfWeek, endOfMonth) {
  if (!monthStart) return []

  const first = new Date(`${monthStart}T00:00:00`)
  if (Number.isNaN(first.getTime())) return []

  const last = endOfMonth(first)
  const mondays = []

  const cursor = new Date(`${startOfWeek(first)}T00:00:00`)
  while (mondays.length < MAX_PLAN_WEEKS) {
    const monday = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
    if (monday > last) break
    mondays.push(monday)
    cursor.setDate(cursor.getDate() + 7)
  }

  return mondays
}
