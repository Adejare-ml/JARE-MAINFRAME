import { formatDuration, formatClock, minutesIntoDay } from '../../lib/calendar'
import Panel from '../ui/Panel'
import StatusDot from '../ui/StatusDot'

/**
 * What today already has in it.
 *
 * Every number this app plans with divides a target by the days remaining. That
 * is right arithmetically and blind in practice: on a Tuesday with six hours of
 * meetings, "set aside two hours for the planner" is not ambitious, it is
 * impossible. So the free time is the headline: it is the figure that changes
 * what you should do.
 *
 * The state it is most careful about is the third one. A day with no meetings
 * and a day the app could not see both arrive as zero events, and saying "you
 * are free all day" when the calendar was unreadable is a confident lie. The
 * `source` column tells them apart.
 */
export default function DayBrief({ brief }) {
  if (!brief) return null

  if (brief.source === 'unavailable') {
    return (
      <Panel label="Today's shape" tone="warn">
        <p className="flex items-start gap-2.5 text-body-sm text-muted">
          <StatusDot status="warn" className="mt-1.5" />
          <span>
            <span className="text-foreground font-semibold">Couldn't read your calendar.</span> Today's figures assume an
            empty day, which may not be true. This brief is from an older run.
          </span>
        </p>
      </Panel>
    )
  }

  const events = Array.isArray(brief.events) ? brief.events : []
  const free = Number(brief.free_minutes) || 0
  const busy = Number(brief.busy_minutes) || 0

  // Under two hours left is worth flagging: the difference between a day
  // you can plan into and one you can only survive.
  const tight = free < 120

  return (
    <Panel label="Today's shape" meta={busy > 0 ? `${formatDuration(busy)} booked` : null} tone={tight ? 'warn' : undefined}>
      <p className="whitespace-nowrap">
        <span className={`text-figure tabular-nums ${tight ? 'text-warn' : 'text-foreground'}`}>{formatDuration(free)}</span>
        <span className="text-body-sm text-muted ml-1.5">free</span>
      </p>

      {events.length === 0 ? (
        <p className="text-body-sm text-muted mt-1">Nothing in the calendar. The day is yours.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {events.map((event, i) => (
            <li key={event.id || `${event.title}-${i}`} className="flex items-baseline gap-3">
              <span className="type-data text-muted-dim w-14 shrink-0">
                {event.allDay ? 'All day' : formatClock(minutesIntoDay(event.start))}
              </span>
              <span className="text-body-sm text-foreground truncate">{event.title}</span>
            </li>
          ))}
        </ul>
      )}

      {tight && events.length > 0 && (
        <p className="text-body-sm text-warn mt-2">Not much room. Worth picking one thing rather than three.</p>
      )}
    </Panel>
  )
}
