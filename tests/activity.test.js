import { describe, it, expect } from 'vitest'
import { buildActivityGrid, currentStreak, DEFAULT_WEEKS } from '../src/lib/activity.js'
import { isTaskDone } from '../src/lib/planning.js'

/** Thursday 13 August 2026. Its week runs Mon 10th to Sun 16th. */
const TODAY = '2026-08-13'

const done = (t) => Boolean(t.completed)
const task = (date, completed = false) => ({ target_date: date, completed })

describe('buildActivityGrid', () => {
  it('returns whole weeks of seven days', () => {
    // The columns sit under weekday labels; a short week misaligns every row
    // after it.
    const grid = buildActivityGrid([], done, { today: TODAY })
    expect(grid).toHaveLength(DEFAULT_WEEKS)
    for (const week of grid) expect(week).toHaveLength(7)
  })

  it('ends on the week containing today', () => {
    const grid = buildActivityGrid([], done, { today: TODAY })
    const lastWeek = grid[grid.length - 1]
    expect(lastWeek[0].date).toBe('2026-08-10')
    expect(lastWeek[6].date).toBe('2026-08-16')
    expect(lastWeek.some((c) => c.isToday)).toBe(true)
  })

  it('anchors on the week, not on today, so rows do not rotate', () => {
    // Anchoring on today would put a different weekday in row 0 every day.
    for (const day of ['2026-08-10', '2026-08-13', '2026-08-16']) {
      const grid = buildActivityGrid([], done, { today: day })
      expect(grid[grid.length - 1][0].date).toBe('2026-08-10')
    }
  })

  it('distinguishes a day with nothing planned from a day where nothing got done', () => {
    // The distinction the whole grid rests on. Rendering both as "nothing"
    // would mark you failed on days you never made a plan for.
    const grid = buildActivityGrid([task(TODAY, false)], done, { today: TODAY })
    const cells = grid.flat()

    const planned = cells.find((c) => c.date === TODAY)
    expect(planned.empty).toBe(false)
    expect(planned.total).toBe(1)
    expect(planned.ratio).toBe(0)

    const unplanned = cells.find((c) => c.date === '2026-08-12')
    expect(unplanned.empty).toBe(true)
    expect(unplanned.total).toBe(0)
  })

  it('computes the completion ratio per day', () => {
    const grid = buildActivityGrid(
      [task(TODAY, true), task(TODAY, true), task(TODAY, false), task(TODAY, false)],
      done,
      { today: TODAY },
    )
    const cell = grid.flat().find((c) => c.date === TODAY)
    expect(cell.done).toBe(2)
    expect(cell.total).toBe(4)
    expect(cell.ratio).toBe(0.5)
  })

  it('marks days after today as future', () => {
    // Friday and the weekend exist as cells so the week keeps its shape, but
    // shading them would claim a verdict on days that have not happened.
    const grid = buildActivityGrid([], done, { today: TODAY })
    const cells = grid.flat()
    expect(cells.find((c) => c.date === '2026-08-14').isFuture).toBe(true)
    expect(cells.find((c) => c.date === TODAY).isFuture).toBe(false)
    expect(cells.find((c) => c.date === '2026-08-12').isFuture).toBe(false)
  })

  it('ignores tasks outside the window rather than distorting it', () => {
    const grid = buildActivityGrid([task('2020-01-01', true)], done, { today: TODAY })
    expect(grid.flat().every((c) => c.empty)).toBe(true)
  })

  it('honours a custom width', () => {
    expect(buildActivityGrid([], done, { today: TODAY, weeks: 3 })).toHaveLength(3)
  })

  it('survives junk rows', () => {
    const grid = buildActivityGrid([null, {}, { target_date: null }], done, { today: TODAY })
    expect(grid.flat().every((c) => c.empty)).toBe(true)
  })

  it('uses the doneness rule it is given, so measured tasks count', () => {
    // The grid must not read `completed` itself -- a measured task never sets
    // it, and would show as permanently missed.
    const measured = {
      target_date: TODAY,
      metric: 'save_at_least',
      target_amount: 100,
      metric_category: 'Savings',
      completed: false,
    }
    const txns = [{ type: 'credit', amount: 100, category: 'Savings', transaction_date: TODAY }]

    const grid = buildActivityGrid([measured], (t) => isTaskDone(t, txns), { today: TODAY })
    expect(grid.flat().find((c) => c.date === TODAY).ratio).toBe(1)
  })
})

describe('currentStreak', () => {
  it('counts consecutive fully-done days', () => {
    const tasks = [
      task('2026-08-11', true),
      task('2026-08-12', true),
      task(TODAY, true),
    ]
    expect(currentStreak(tasks, done, { today: TODAY })).toBe(3)
  })

  it('breaks on a day where something was left undone', () => {
    const tasks = [
      task('2026-08-11', true),
      task('2026-08-12', false),
      task(TODAY, true),
    ]
    expect(currentStreak(tasks, done, { today: TODAY })).toBe(1)
  })

  it('does not break the streak on an unfinished today', () => {
    // The day is not over. Counting it as a failure at 9am would make the
    // number drop every morning and climb back every evening.
    const tasks = [
      task('2026-08-11', true),
      task('2026-08-12', true),
      task(TODAY, false),
    ]
    expect(currentStreak(tasks, done, { today: TODAY })).toBe(2)
  })

  it('treats a day with no tasks as neither success nor failure', () => {
    // 12 Aug has nothing planned; it should not break the run, nor pad it.
    const tasks = [
      task('2026-08-11', true),
      task(TODAY, true),
    ]
    expect(currentStreak(tasks, done, { today: TODAY })).toBe(2)
  })

  it('ignores future rows', () => {
    const tasks = [task(TODAY, true), task('2026-08-20', false)]
    expect(currentStreak(tasks, done, { today: TODAY })).toBe(1)
  })

  it('is zero with no history at all', () => {
    expect(currentStreak([], done, { today: TODAY })).toBe(0)
    expect(currentStreak(null, done, { today: TODAY })).toBe(0)
  })
})
