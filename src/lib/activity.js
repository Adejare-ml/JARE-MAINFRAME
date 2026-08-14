/**
 * The activity grid: what the last two months of days actually looked like.
 *
 * Dayflow's standup opens with a GitHub-style grid of the day. The same shape
 * works here for a different quantity -- not commits, but whether the things
 * you said you would do got done -- and it answers a question no list on this
 * page answers: not "what is today", but "how have I been doing".
 *
 * Kept out of planning.js on purpose. That module turns a goal into the task it
 * implies; this one summarises what already happened. They share no logic and
 * mixing them would make a file that is about the future also about the past.
 *
 * Pure, so the shape of the grid can be tested without rendering anything.
 */

import { toDateOnly, startOfWeek } from './queries.js'

/** Weeks shown by default. Eight is two months -- long enough to see a habit
 *  form or lapse, short enough to fit a phone without scrolling sideways. */
export const DEFAULT_WEEKS = 8

/**
 * Build a Monday-first grid of daily completion.
 *
 * Returns whole weeks always, so the columns line up under their weekday
 * labels. Days before the window and days after today are still present as
 * cells -- they are marked rather than omitted, because a grid with holes in it
 * misaligns everything that follows.
 *
 * A day with no tasks is `empty`, which is deliberately NOT the same as a day
 * where nothing got done. Rendering both as "nothing" would say you failed on
 * days you never made a plan for.
 *
 * @param {Array<{target_date: string}>} tasks - daily rows, any date range
 * @param {(task: object) => boolean} isDone - decides doneness per task
 * @param {{weeks?: number, today?: string}} [options]
 * @returns {Array<Array<{date: string, total: number, done: number, ratio: number, empty: boolean, isFuture: boolean, isToday: boolean}>>}
 */
export function buildActivityGrid(tasks, isDone, { weeks = DEFAULT_WEEKS, today = toDateOnly(new Date()) } = {}) {
  const byDate = new Map()

  for (const task of tasks || []) {
    if (!task?.target_date) continue
    if (!byDate.has(task.target_date)) byDate.set(task.target_date, [])
    byDate.get(task.target_date).push(task)
  }

  // Anchor on the Monday of the CURRENT week and count back, so the last
  // column is always this week and today always sits in it. Anchoring on today
  // instead would rotate the weekday rows every day of the week.
  const lastMonday = new Date(`${startOfWeek(new Date(`${today}T00:00:00`))}T00:00:00`)
  const firstMonday = new Date(lastMonday)
  firstMonday.setDate(firstMonday.getDate() - (weeks - 1) * 7)

  const grid = []
  const cursor = new Date(firstMonday)

  for (let w = 0; w < weeks; w++) {
    const week = []
    for (let d = 0; d < 7; d++) {
      const date = toDateOnly(cursor)
      const dayTasks = byDate.get(date) || []
      const total = dayTasks.length
      const done = dayTasks.filter((t) => isDone(t)).length

      week.push({
        date,
        total,
        done,
        ratio: total > 0 ? done / total : 0,
        empty: total === 0,
        isFuture: date > today,
        isToday: date === today,
      })

      cursor.setDate(cursor.getDate() + 1)
    }
    grid.push(week)
  }

  return grid
}

/**
 * Consecutive days ending today (or yesterday) where every task was done.
 *
 * Days with no tasks do not break a streak and do not extend it -- a day you
 * made no plan for is neither a success nor a failure, and counting it either
 * way makes the number a lie in one direction or the other.
 *
 * Today is allowed to be incomplete without breaking the streak: the day is not
 * over. It only counts toward the streak once it is actually finished.
 *
 * @returns {number}
 */
export function currentStreak(tasks, isDone, { today = toDateOnly(new Date()) } = {}) {
  const byDate = new Map()
  for (const task of tasks || []) {
    if (!task?.target_date) continue
    if (task.target_date > today) continue
    if (!byDate.has(task.target_date)) byDate.set(task.target_date, [])
    byDate.get(task.target_date).push(task)
  }

  let streak = 0
  const cursor = new Date(`${today}T00:00:00`)

  // Walk back a bounded distance rather than until a break: an unbounded loop
  // over a sparse map is one bad date away from spinning.
  for (let i = 0; i < 366; i++) {
    const date = toDateOnly(cursor)
    const dayTasks = byDate.get(date)

    if (dayTasks && dayTasks.length > 0) {
      const allDone = dayTasks.every((t) => isDone(t))
      if (allDone) {
        streak++
      } else if (date !== today) {
        break
      }
      // An unfinished TODAY neither counts nor breaks -- the day is still going.
    }

    cursor.setDate(cursor.getDate() - 1)
  }

  return streak
}

/** Weekday initials for the grid's row labels, Monday first. */
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
