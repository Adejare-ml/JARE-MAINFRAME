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

import { toDateOnly, startOfWeek, endOfWeek, endOfMonth } from './queries.js'
import { TRANSFER_CATEGORIES } from './summary.js'

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
 * @returns {{measured: boolean, done: number, target: number, share: number, met: boolean, source: string}}
 */
export function goalProgress(goal, transactions = []) {
  const metric = goal?.metric || 'manual'

  if (metric === 'manual') {
    return {
      measured: false,
      done: goal?.completed ? 1 : 0,
      target: 1,
      share: goal?.completed ? 1 : 0,
      met: Boolean(goal?.completed),
      source: 'ticked by hand',
    }
  }

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
  return progress.measured ? progress.met : Boolean(goal?.completed)
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
    title:
      goal.metric === 'save_at_least'
        ? `Set aside ₦${perPeriod.toLocaleString('en-NG')} toward ${goal.title}`
        : `Keep ${goal.metric_category || goal.title} under ₦${perPeriod.toLocaleString('en-NG')} this week`,
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
    title:
      goal.metric === 'save_at_least'
        ? `Set aside ₦${perPeriod.toLocaleString('en-NG')} today`
        : `Spend under ₦${perPeriod.toLocaleString('en-NG')} on ${goal.metric_category || goal.title} today`,
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
    if (row.parent_id) byLineage.set(lineage(row), row)

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
      // A person typed here, or ticked it. Either way it is theirs now.
      if (found.generated === false || found.completed) {
        kept.push(found)
        continue
      }

      // Nothing about it has changed, so writing it would be a round trip that
      // updates a row to the value it already holds.
      if (found.title === row.title && Number(found.target_amount) === Number(row.target_amount)) {
        unchanged.push(found)
        continue
      }

      write.push({ ...row, slot: found.slot, id: found.id })
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
