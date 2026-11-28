import { buildActivityGrid, currentStreak, WEEKDAY_INITIALS } from '../../lib/activity'
import { formatDate } from '../../lib/formatters'
import Panel from '../ui/Panel'

/**
 * Eight weeks of days, shaded by how much of each day's plan got done.
 *
 * Four shades rather than a gradient: at this size the eye cannot read a
 * smooth ramp, and banding makes "most of it" and "all of it" tell apart. A
 * day with nothing planned is an empty outline, not a dark cell: you did not
 * fail on a day you never made a plan for. A legend says which is which, so
 * colour is not the only carrier of the meaning.
 */
function shade(cell) {
  if (cell.isFuture) return 'border border-border'
  if (cell.empty) return 'border border-border'
  // Pending a verdict, not missed: a dashed outline reads as undecided.
  if (cell.unknown) return 'border border-dashed border-border-strong'
  if (cell.ratio >= 1) return 'bg-accent'
  if (cell.ratio >= 0.5) return 'bg-accent/60'
  if (cell.ratio > 0) return 'bg-accent/30'
  return 'bg-border'
}

const LEGEND = [
  { label: 'None', cls: 'bg-border' },
  { label: 'Some', cls: 'bg-accent/30' },
  { label: 'Most', cls: 'bg-accent/60' },
  { label: 'All', cls: 'bg-accent' },
]

export default function ActivityGrid({ tasks, isDone, today, isUnknown }) {
  const grid = buildActivityGrid(tasks, isDone, { today, ...(isUnknown ? { isUnknown } : {}) })
  const streak = currentStreak(tasks, isDone, { today })
  const planned = grid.flat().filter((c) => !c.empty && !c.isFuture)

  return (
    <Panel label="Activity" meta={streak > 0 ? `${streak} day${streak === 1 ? '' : 's'} clean` : 'Eight weeks'}>
      {planned.length === 0 ? (
        <p className="text-body-sm text-muted">Days you plan and finish will fill in here.</p>
      ) : (
        <>
          <div className="flex gap-2">
            {/* Weekday labels, on the same rows as the cells. */}
            <div className="grid grid-rows-7 gap-1 type-data text-xs leading-3 text-muted-dim" aria-hidden="true">
              {WEEKDAY_INITIALS.map((letter, i) => (
                <span key={i} className="h-3 w-3 text-center">
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
                          ? `${formatDate(cell.date)}: nothing planned`
                          : cell.unknown
                            ? `${formatDate(cell.date)}: not checked yet`
                            : `${formatDate(cell.date)}: ${cell.done}/${cell.total} done`
                      }
                      className={`w-3 h-3 rounded-[2px] ${shade(cell)} ${cell.isToday ? 'outline outline-1 outline-offset-1 outline-foreground' : ''}`}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 mt-3 type-data text-muted-dim">
            {LEGEND.map((l) => (
              <span key={l.label} className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`w-3 h-3 rounded-[2px] ${l.cls}`} />
                {l.label}
              </span>
            ))}
          </div>
        </>
      )}
    </Panel>
  )
}
