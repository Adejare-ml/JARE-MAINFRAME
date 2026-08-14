/**
 * Turning a goal into what to do about it today.
 *
 * A monthly goal is a number and a deadline. On its own that is a wish: "save
 * ₦150,000 in August" tells you nothing on the 12th, when what you need to know
 * is whether you are behind and by how much. This module does the arithmetic
 * that turns the first into the second.
 *
 * Deliberately arithmetic rather than inference, for the same reason transaction
 * direction is decided by subtracting two balances instead of asking a model:
 * the sum is explainable, it is the same every run, and it can be checked by
 * hand. It is also the only option that works -- browser code cannot hold an
 * API key (see src/lib/gmailSync.js), so anything model-shaped would have to
 * live in a scheduled Action.
 *
 * Pure, and importing nothing from supabase.js, so every rule below is testable
 * without a database. src/lib/schema.js is the precedent: it takes the client
 * as an argument rather than importing it.
 */

import { toDateOnly, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from './queries.js'
import { TRANSFER_CATEGORIES } from './summary.js'
import { formatGoalAmount } from './formatters.js'

/**
 * Where generated rows start. Slots 0-9 are hand-typed -- Daily HQ writes the
 * array index of its three priority boxes, so they are 0, 1 and 2 -- and
 * migration 009 enforces this boundary with a check constraint, so a generator
 * bug cannot overwrite something a person wrote.
 */
export const GENERATED_SLOT_BASE = 10

/** Most derived tasks to put on one day. Beyond this it is a wall, not a plan. */
export const MAX_GENERATED_PER_DAY = 4

/**
 * The metric whose evidence comes from a repository rather than the ledger.
 *
 * Named because it is checked in several places and each of them is doing
 * something structurally different -- deciding a title, deciding whether a tick
 * may override the measurement, deciding which unit a number is in. A bare
 * string literal in all three would hide the fact that they are related.
 */
export const REPO_METRIC = 'repo_commits'

/**
 * The inclusive range of local days a goal's progress is measured over.
 *
 * `target_date` is the period the goal is FOR, not a deadline: the 1st for a
 * monthly goal, the Monday for a weekly one, the day itself for a daily one.
 * Turning that back into a window is what lets the repo verifier ask the same
 * question of all three cadences -- how many commits between these two dates --
 * rather than special-casing each.
 *
 * @param {{period?: string, target_date?: string}} goal
 * @returns {{from: string, to: string}|null}
 */
export function periodWindow(goal) {
  const anchor = goal?.target_date
  if (!anchor) return null

  const date = new Date(`${anchor}T00:00:00`)
  if (Number.isNaN(date.getTime())) return null

  if (goal.period === 'weekly') return { from: startOfWeek(date), to: endOfWeek(date) }
  if (goal.period === 'monthly') return { from: startOfMonth(date), to: endOfMonth(date) }
  return { from: anchor, to: anchor }
}

/**
 * Whole days from `from` to `to`, inclusive of both ends.
 *
 * Inclusive because a goal due on the 31st can still be worked on during the
 * 31st. Counting exclusively is how a plan quietly loses its last day.
 */
export function daysBetween(from, to) {
  const a = new Date(`${from}T00:00:00`)
  const b = new Date(`${to}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0
  return Math.floor((b - a) / 86400000) + 1
}

/**
 * How many calendar weeks a monthly goal still has, counting the current
 * (possibly part-) week as one.
 *
 * Always at least 1: on the last day of the month you still have today, and
 * dividing by zero would make the target Infinity -- which renders as a
 * nonsense number rather than an honest "this is due now".
 *
 * @param {string} deadline - YYYY-MM-DD
 * @param {string} today - YYYY-MM-DD
 * @returns {number} integer >= 1
 */
export function weeksRemaining(deadline, today) {
  if (!deadline || !today || deadline < today) return 1
  const firstMonday = startOfWeek(new Date(`${today}T00:00:00`))
  const lastMonday = startOfWeek(new Date(`${deadline}T00:00:00`))
  const weeks = Math.round(daysBetween(firstMonday, lastMonday) / 7)
  return Math.max(1, weeks)
}

/**
 * How much of a measurable goal is already done, read from the ledger.
 *
 * This is the part worth having. A goal with a metric does not wait to be
 * ticked -- it reads the transactions the Gmail sync imported and answers for
 * itself, the same way the ledger types itself from bank alerts.
 *
 * Transfers are excluded from `spend_under` for the reason summarizeMonth
 * excludes them from spending: moving money to PiggyVest writes a debit on
 * GTBank, and counting that as spending made saving look like overspending.
 * They are NOT excluded from `save_at_least`, because a savings transfer is
 * exactly what that goal is asking for.
 *
 * @param {{metric?: string, target_amount?: number, metric_category?: string, metric_wallet_id?: string, completed?: boolean}} goal
 * @param {Array<object>} transactions - rows already scoped to the goal's period
 * @returns {{measured: boolean, overridable: boolean, checked: boolean, done: number, target: number, share: number, met: boolean, source: string}}
 */
export function goalProgress(goal, transactions = []) {
  const metric = goal?.metric || 'manual'

  if (metric === 'manual') {
    return {
      measured: false,
      overridable: true,
      checked: true,
      done: goal?.completed ? 1 : 0,
      target: 1,
      share: goal?.completed ? 1 : 0,
      met: Boolean(goal?.completed),
      source: 'ticked by hand',
    }
  }

  if (metric === REPO_METRIC) return repoProgress(goal)

  const target = Number(goal?.target_amount) || 0
  const wantCredit = metric === 'save_at_least'
  let done = 0

  for (const t of transactions || []) {
    if (t.voided) continue

    const amount = Number(t.amount) || 0
    if (amount <= 0) continue

    if (goal.metric_wallet_id && t.wallet_id !== goal.metric_wallet_id) continue
    if (goal.metric_category && t.category !== goal.metric_category) continue

    if (wantCredit) {
      if (t.type === 'credit') done += amount
    } else {
      // A transfer out is not spending, it is the same money in another pocket.
      if (t.type === 'debit' && !TRANSFER_CATEGORIES.includes(t.category)) done += amount
    }
  }

  const share = target > 0 ? done / target : 0

  return {
    measured: true,
    // Money is not overridable. A transaction either exists or it does not, and
    // letting a checkbox stand in for one would make the goal disagree with the
    // ledger it is measured against.
    overridable: false,
    checked: true,
    done,
    target,
    share,
    // "Under budget" is only true while you are under it; "saved enough" only
    // once you have. Same number, opposite comparison.
    met: wantCredit ? done >= target && target > 0 : done <= target,
    source: goal.metric_category
      ? `from ${goal.metric_category} transactions`
      : 'from this wallet’s transactions',
  }
}

/**
 * Progress on a goal about code, read from what the verifier wrote down.
 *
 * The only place in this app where progress is READ rather than DERIVED, and
 * the exception is forced rather than chosen: measuring it means asking GitHub,
 * the browser has no GitHub credentials, and giving it any would put a token
 * capable of writing to the repository into a bundle served to the public
 * internet. So scripts/verify-repo.mjs -- which runs where the credentials
 * already are -- writes `evidence` and `verified_at`, and this reads them.
 *
 * `checked` is the part that must not be dropped on the way to the screen.
 * There are three states here, not two:
 *
 *   verified_at null      nobody has looked yet
 *   checked, counted 0    looked, found nothing
 *   checked, counted n    looked, found n
 *
 * The first is not a failure and must never be drawn as one -- it is the same
 * error as reading a sync run that imported nothing as an empty inbox. The
 * second is not necessarily a failure either, which is what `overridable`
 * exists for: office work leaves no commits.
 */
function repoProgress(goal) {
  const evidence = goal?.evidence && typeof goal.evidence === 'object' ? goal.evidence : null
  const checked = Boolean(goal?.verified_at)
  const target = Number(goal?.target_amount) || 0

  const counted = Number(evidence?.counted)
  const done = Number.isFinite(counted) && counted >= 0 ? counted : 0

  const repo = evidence?.repo

  return {
    measured: true,
    overridable: true,
    checked,
    done,
    target,
    share: target > 0 ? done / target : 0,
    // Unchecked can never be met. Reporting a goal as done on evidence nobody
    // has gathered is the failure mode this whole stage is built to avoid.
    met: checked && target > 0 && done >= target,
    source: !checked
      ? 'not checked yet'
      : repo
        ? `counted on ${repo}`
        : 'counted on the repository',
  }
}

/**
 * Is this task done?
 *
 * Two different questions wearing one word. A task you typed is done when you
 * say so; a measured one is done when the transactions say so, and no earlier.
 * Keeping the rule here rather than at each call site is not tidiness -- it was
 * written inline on the Goals page first, and Daily HQ needs the same answer.
 * Two copies of "what counts as done" is how the app ends up disagreeing with
 * itself about whether you had a good day.
 *
 * @param {object} goal
 * @param {Array<object>} transactions - rows scoped to the goal's own period
 * @returns {boolean}
 */
export function isTaskDone(goal, transactions = []) {
  const progress = goalProgress(goal, transactions)
  if (!progress.measured) return Boolean(goal?.completed)

  // Some work genuinely leaves nothing to measure. A repo goal met by a day of
  // reviews, a design decision or an afternoon in the office produces no
  // commits at all, and a system that called that a failure would be teaching
  // you to distrust it. So a tick counts here, on top of the evidence rather
  // than instead of it. Money gets no such loophole -- see `overridable`.
  if (progress.overridable) return progress.met || Boolean(goal?.completed)

  return progress.met
}

/**
 * What this goal still needs, and per period from here.
 *
 * Recomputed from what is actually left rather than from the original target
 * divided by the original span, so falling behind raises the number instead of
 * quietly shrinking the goal. That is the honest direction: a plan that adjusts
 * downward every time you miss it will always report success.
 *
 * @returns {{remaining: number, perPeriod: number, periods: number, onTrack: boolean}}
 */
export function pace(goal, progress, periods) {
  const target = Number(goal?.target_amount) || 0
  const done = Number(progress?.done) || 0
  const slices = Math.max(1, Math.floor(periods) || 1)
  const remaining = Math.max(0, target - done)

  return {
    remaining,
    // Rounded up: N slices of the rounded-down figure never reaches the target.
    perPeriod: Math.ceil(remaining / slices),
    periods: slices,
    onTrack: remaining === 0,
  }
}

/**
 * Break a monthly goal into the weekly goal for the week containing `today`.
 *
 * One week at a time, not all of them at once: next week's number depends on
 * what this week actually does, and writing five weeks up front would either be
 * wrong by Wednesday or need rewriting every day.
 *
 * @returns {object|null} a goals row ready to upsert, or null if nothing is due
 */
export function decomposeMonthly(goal, progress, today = toDateOnly(new Date())) {
  if (!goal || goal.period !== 'monthly') return null
  if (goal.metric === 'manual') return null

  // `target_date` is the period this goal is FOR, never a free-form deadline --
  // the 1st for a monthly goal, the Monday for a weekly one, the day itself for
  // a daily one. Keeping that uniform is what lets the unique index on
  // (period, target_date, slot) mean "one set of goals per period", and it is
  // why the deadline is derived here rather than stored: a monthly goal is due
  // when its month ends.
  const anchor = goal.target_date || today
  const deadline = endOfMonth(new Date(`${anchor}T00:00:00`))
  const weeks = weeksRemaining(deadline, today)
  const { remaining, perPeriod } = pace(goal, progress, weeks)

  // Already there. Saying nothing is right: a task telling you to save money
  // you have already saved is noise that teaches you to ignore the list.
  if (remaining === 0) return null

  return {
    title: weeklyTitle(goal, perPeriod),
    period: 'weekly',
    target_date: startOfWeek(new Date(`${today}T00:00:00`)),
    slot: GENERATED_SLOT_BASE,
    parent_id: goal.id,
    generated: true,
    metric: goal.metric,
    target_amount: perPeriod,
    metric_category: goal.metric_category ?? null,
    metric_wallet_id: goal.metric_wallet_id ?? null,
  }
}

/**
 * Break a weekly goal into today's task.
 *
 * Divides by the days LEFT in the week, not by seven, so a goal created on
 * Friday asks for a Friday-sized share rather than pretending Monday is still
 * available.
 *
 * @returns {object|null}
 */
export function decomposeWeekly(goal, progress, today = toDateOnly(new Date())) {
  if (!goal || goal.period !== 'weekly') return null
  if (goal.metric === 'manual') return null

  const weekEnd = endOfWeek(new Date(`${today}T00:00:00`))
  const daysLeft = Math.max(1, daysBetween(today, weekEnd))
  const { remaining, perPeriod } = pace(goal, progress, daysLeft)

  if (remaining === 0) return null

  return {
    title: dailyTitle(goal, perPeriod),
    period: 'daily',
    target_date: today,
    slot: GENERATED_SLOT_BASE,
    parent_id: goal.id,
    generated: true,
    metric: goal.metric,
    target_amount: perPeriod,
    metric_category: goal.metric_category ?? null,
    metric_wallet_id: goal.metric_wallet_id ?? null,
  }
}

/**
 * What the derived row is called.
 *
 * Kept together rather than inline at each decomposition, because the three
 * metrics differ only in wording and the shape of the sentence is what makes a
 * generated task readable as an instruction rather than as a database row.
 *
 * The repo wording is deliberately generic -- "3 commits toward Ship the
 * planner" is arithmetic, not a plan. Stage 8's model-written titles replace
 * this string and nothing else: the row, the lineage and the verification are
 * all already correct, which is why the generic version is worth shipping
 * first. A number you can explain beats a suggestion you cannot.
 */
function weeklyTitle(goal, perPeriod) {
  if (goal.metric === REPO_METRIC) {
    return `${formatGoalAmount(perPeriod, REPO_METRIC)} toward ${goal.title} this week`
  }
  if (goal.metric === 'save_at_least') {
    return `Set aside ₦${perPeriod.toLocaleString('en-NG')} toward ${goal.title}`
  }
  return `Keep ${goal.metric_category || goal.title} under ₦${perPeriod.toLocaleString('en-NG')} this week`
}

function dailyTitle(goal, perPeriod) {
  if (goal.metric === REPO_METRIC) {
    return `Ship ${formatGoalAmount(perPeriod, REPO_METRIC)} today`
  }
  if (goal.metric === 'save_at_least') {
    return `Set aside ₦${perPeriod.toLocaleString('en-NG')} today`
  }
  return `Spend under ₦${perPeriod.toLocaleString('en-NG')} on ${goal.metric_category || goal.title} today`
}

/** Identity of a derived row: which goal produced it, for which period. */
function lineage(row) {
  return `${row.parent_id}|${row.period}|${row.target_date}`
}

/**
 * Which generated rows may be written, given what is already stored.
 *
 * Two rules carry this function.
 *
 * **Never overwrite a human decision.** A derived task that has been ticked, or
 * that turns out to be sitting in a row a person typed, is left exactly as it
 * is. Regeneration is only ever for rows nobody has touched. This follows the
 * precedent in DailyHQ's priority upsert, which omits `completed` from its
 * payload on purpose so that saving an edit cannot untick a box.
 *
 * **Identity is the parent, not the slot.** Matching on
 * (period, target_date, slot) looked fine and was not: slots are handed out by
 * position, so adding one goal renumbers the rest, and the task derived from
 * goal A lands on the row derived from goal B -- rewriting it, with no error
 * anywhere. A goal produces at most one task per period, so the parent is what
 * makes a row the same row, and the stored slot is reused rather than
 * recomputed.
 *
 * @param {Array<object>} candidates - freshly derived rows, each with parent_id
 * @param {Array<object>} existing - stored rows for the same periods
 * @returns {{write: Array<object>, kept: Array<object>, unchanged: Array<object>}}
 */
export function reconcileGenerated(candidates, existing = []) {
  const byLineage = new Map()
  const takenSlots = new Map()

  for (const row of existing || []) {
    if (!row) continue
    if (row.parent_id) {
      // A planned row wins the lineage. The planner writes one row per week of
      // the month and the generator only ever owns the current week, so the two
      // meet on exactly one week at a time -- and when they do, the row
      // carrying the plan is the one that should survive. Taking whichever
      // happened to be last in the array would make it depend on row order.
      const held = byLineage.get(lineage(row))
      if (!held?.focus) byLineage.set(lineage(row), row)
    }

    const key = `${row.period}|${row.target_date}`
    if (!takenSlots.has(key)) takenSlots.set(key, new Set())
    if (row.slot != null) takenSlots.get(key).add(row.slot)
  }

  const write = []
  const kept = []
  const unchanged = []
  const perPeriod = new Map()

  for (const row of candidates || []) {
    if (!row) continue
    const found = byLineage.get(lineage(row))

    if (found) {
      // A person ticked it. That is a decision, and nothing regenerates over a
      // decision.
      if (found.completed) {
        kept.push(found)
        continue
      }

      // A person typed here. Theirs -- unless it carries a `focus`, which means
      // it came from an approved plan.
      //
      // A planned row is owned twice, on purpose. The model wrote the words and
      // the arithmetic owns the number, and neither may overwrite the other:
      // `focus` and `plan_evidence` are absent from every payload below, so a
      // PostgREST upsert leaves them exactly as they are, while `title` and
      // `target_amount` are recomputed the same way they are on any other
      // derived row.
      //
      // Skipping it instead -- which is what treating it as hand-typed did --
      // left the planned week with no number at all, so decomposeWeekly found
      // nothing to divide and that week produced no daily task. Approving a
      // plan would have quietly emptied the week it was a plan for.
      if (found.generated === false && !found.focus) {
        kept.push(found)
        continue
      }

      // Nothing about it has changed, so writing it would be a round trip that
      // updates a row to the value it already holds.
      if (found.title === row.title && Number(found.target_amount) === Number(row.target_amount)) {
        unchanged.push(found)
        continue
      }

      // No `id` in the payload, deliberately. PostgREST rejects a bulk upsert
      // whose objects do not all carry the same keys (PGRST102, "All object
      // keys must match"), and this array mixes updates with inserts the moment
      // you hold two goals and only one of them has moved. The unique index on
      // (period, target_date, slot) is the conflict target and the stored slot
      // is reused just above, so the row is identified without it -- and the
      // caller's `.select()` still returns the real id.
      write.push({ ...row, slot: found.slot })
      continue
    }

    // A parent seen for the first time: give it the lowest free generated slot,
    // and cap how many derived tasks may land on one day. Beyond the cap it is
    // a wall, not a plan.
    const key = `${row.period}|${row.target_date}`
    const made = perPeriod.get(key) || 0
    if (made >= MAX_GENERATED_PER_DAY) continue

    const taken = takenSlots.get(key) || new Set()
    let slot = GENERATED_SLOT_BASE
    while (taken.has(slot)) slot++

    taken.add(slot)
    takenSlots.set(key, taken)
    perPeriod.set(key, made + 1)
    write.push({ ...row, slot })
  }

  return { write, kept, unchanged }
}
