import { formatDuration, formatClock, minutesIntoDay } from '../../lib/calendar'

/**
 * What today already has in it.
 *
 * Every number this app plans with divides a target by the days remaining. That
 * is right arithmetically and blind in practice: on a Tuesday with six hours of
 * meetings, "set aside two hours for the planner" is not ambitious, it is
 * impossible — and missing it reads as a personal failure rather than as a plan
 * made without looking.
 *
 * So this sits above the task list rather than below it. The free figure is the
 * headline because it is the one that changes what you should do.
 *
 * The state it is most careful about is the third one. A day with no meetings
 * and a day the app could not see both arrive as zero events, and saying "you
 * are free all day" when the calendar was unreadable is a confident lie. The
 * `source` column exists to tell them apart, and this is where that pays off.
 */
export default function DayBrief({ brief }) {
  if (!brief) return null

  if (brief.source === 'unavailable') {
    return (
      <section className="bg-card rounded-3xl p-5 border border-yellow-500/20">
        <p className="text-xs text-yellow-200/90 leading-relaxed">
          <span className="font-bold">Couldn’t read your calendar.</span> Today’s figures
          below assume an empty day, which may not be true. If this keeps happening, the
          Google token probably needs the calendar scope — re-run{' '}
          <code className="font-mono text-yellow-100">scripts/get-refresh-token.mjs</code>.
        </p>
      </section>
    )
  }

  const events = Array.isArray(brief.events) ? brief.events : []
  const free = Number(brief.free_minutes) || 0
  const busy = Number(brief.busy_minutes) || 0

  // Under two hours left is worth flagging: it is the difference between a day
  // you can plan into and one you can only survive.
  const tight = free < 120

  return (
    <section className="bg-card rounded-3xl p-5 border border-white/5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Today’s shape</h2>
        {busy > 0 && (
          <span className="text-[11px] text-muted tabular-nums">{formatDuration(busy)} booked</span>
        )}
      </div>

      <p className={`text-2xl font-bold tabular-nums ${tight ? 'text-yellow-400' : 'text-white'}`}>
        {formatDuration(free)}
        <span className="text-muted text-sm font-normal"> free</span>
      </p>

      {events.length === 0 ? (
        <p className="text-xs text-muted">Nothing in the calendar. The day is yours.</p>
      ) : (
        <ul className="space-y-1">
          {events.map((event, i) => (
            <li
              key={event.id || `${event.title}-${i}`}
              className="flex items-baseline gap-2 text-xs"
            >
              <span className="text-muted tabular-nums w-11 flex-shrink-0">
                {event.allDay ? 'all day' : formatClock(minutesIntoDay(event.start))}
              </span>
              <span className="text-white/80 truncate">{event.title}</span>
            </li>
          ))}
        </ul>
      )}

      {tight && events.length > 0 && (
        <p className="text-[11px] text-yellow-400/90">
          Not much room. Worth picking one thing rather than three.
        </p>
      )}
    </section>
  )
}
