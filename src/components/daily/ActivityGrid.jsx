import { buildActivityGrid, currentStreak, WEEKDAY_INITIALS } from '../../lib/activity'
import { formatDate } from '../../lib/formatters'

/**
 * Eight weeks of days, shaded by how much of each day's plan got done.
 *
 * Four shades rather than a continuous gradient: at this cell size the eye
 * cannot read a smooth ramp anyway, and banding makes "most of it" and "all of
 * it" tell apart at a glance.
 *
 * A day with nothing planned is drawn as an empty outline, not as a dark cell.
 * Those are different facts and the grid would be lying if it merged them --
 * you did not fail on a day you never made a plan for.
 */
function shade(cell) {
  if (cell.isFuture) return 'bg-transparent border border-white/5'
  if (cell.empty) return 'bg-white/[0.03] border border-white/5'
  if (cell.ratio >= 1) return 'bg-accent'
  if (cell.ratio >= 0.5) return 'bg-accent/60'
  if (cell.ratio > 0) return 'bg-accent/30'
  return 'bg-white/10'
}

export default function ActivityGrid({ tasks, isDone, today }) {
  const grid = buildActivityGrid(tasks, isDone, { today })
  const streak = currentStreak(tasks, isDone, { today })
  const planned = grid.flat().filter((c) => !c.empty && !c.isFuture)

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Activity</h2>
        {streak > 0 && (
          <span className="text-xs font-bold text-accent tabular-nums">
            {streak} day{streak === 1 ? '' : 's'} clean 🔥
          </span>
        )}
      </div>

      {planned.length === 0 ? (
        <p className="text-xs text-muted py-2">
          Days you plan and finish will fill in here.
        </p>
      ) : (
        <div className="flex gap-2">
          {/* Weekday labels. Aligned to the same 1fr rows as the cells so they
              cannot drift apart when the grid changes width. */}
          <div className="grid grid-rows-7 gap-1 text-[9px] text-muted-dim pt-0.5">
            {WEEKDAY_INITIALS.map((letter, i) => (
              <span key={i} className="h-3 leading-3 w-2 text-center" aria-hidden="true">
                {i % 2 === 0 ? letter : ''}
              </span>
            ))}
          </div>

          <div className="flex gap-1 overflow-x-auto scrollbar-none flex-1">
            {grid.map((week) => (
              <div key={week[0].date} className="grid grid-rows-7 gap-1">
                {week.map((cell) => (
                  <span
                    key={cell.date}
                    title={
                      cell.empty
                        ? `${formatDate(cell.date)} — nothing planned`
                        : `${formatDate(cell.date)} — ${cell.done}/${cell.total} done`
                    }
                    className={`w-3 h-3 rounded-sm ${shade(cell)} ${
                      cell.isToday ? 'ring-1 ring-white/40' : ''
                    }`}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
