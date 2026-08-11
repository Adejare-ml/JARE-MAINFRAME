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

  const deadline = goal.target_date || endOfMonth(new Date(`${today}T00:00:00`))
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

/**
 * Assign distinct slots to rows headed for the same (period, target_date), and
 * cap how many land on one day.
 *
 * The unique index is on (period, target_date, slot), so two derived tasks both
 * claiming GENERATED_SLOT_BASE would make the second upsert overwrite the
 * first -- silently, leaving one goal with no task and no error anywhere.
 */
export function assignSlots(rows) {
  const perKey = new Map()
  const out = []

  for (const row of rows) {
    if (!row) continue
    const key = `${row.period}|${row.target_date}`
    const used = perKey.get(key) || 0
    if (used >= MAX_GENERATED_PER_DAY) continue
    perKey.set(key, used + 1)
    out.push({ ...row, slot: GENERATED_SLOT_BASE + used })
  }

  return out
}

/**
 * Which generated rows may be written, given what is already in the database.
 *
 * The rule that matters: **never overwrite a human decision.** A generated task
 * that has been ticked, or whose title has been edited, is left exactly as it
 * is. Regeneration is for rows nobody has touched.
 *
 * This follows the precedent already in DailyHQ's priority upsert, which omits
 * `completed` from its payload on purpose so that saving an edit cannot untick
 * a box the user already ticked.
 *
 * @param {Array<object>} candidates - freshly derived rows
 * @param {Array<object>} existing - rows already stored for those keys
 * @returns {{write: Array<object>, kept: Array<object>}}
 */
export function reconcileGenerated(candidates, existing = []) {
  const byKey = new Map(
    (existing || []).map((row) => [`${row.period}|${row.target_date}|${row.slot}`, row]),
  )

  const write = []
  const kept = []

  for (const row of candidates || []) {
    const found = byKey.get(`${row.period}|${row.target_date}|${row.slot}`)

    if (!found) {
      write.push(row)
      continue
    }

    // Someone typed here. Generated rows live at slot 10+, but a hand-typed row
    // could still be sitting there from before the constraint existed.
    if (found.generated === false) {
      kept.push(found)
      continue
    }

    if (found.completed) {
      kept.push(found)
      continue
    }

    write.push({ ...row, id: found.id })
  }

  return { write, kept }
}
