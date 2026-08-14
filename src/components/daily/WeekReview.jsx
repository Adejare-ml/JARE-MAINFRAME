import { Link } from 'react-router-dom'
import { formatNaira, formatDate } from '../../lib/formatters'
import CategoryBreakdown from '../ui/CategoryBreakdown'
import { spendByWeekday, compareWeeks, carriedOver } from '../../lib/weekreview'
import { goalProgress } from '../../lib/planning'

/** A signed change, coloured by whether it is good news rather than by sign. */
function Delta({ change, lowerIsBetter }) {
  if (change.delta === 0) return <span className="text-muted text-xs">same as last week</span>

  const up = change.delta > 0
  const good = lowerIsBetter ? !up : up
  const pct = change.share == null ? null : Math.abs(Math.round(change.share * 100))

  return (
    <span className={`text-xs font-semibold ${good ? 'text-accent' : 'text-orange-400'}`}>
      {up ? '↑' : '↓'} {formatNaira(Math.abs(change.delta))}
      {/* No percentage when last week was zero -- "up 100%" from nothing is a
          division that completed, not a fact worth printing. */}
      {pct != null && <span className="text-muted font-normal"> ({pct}%)</span>}
    </span>
  )
}

/**
 * The week at a glance: where it went, how it compares, and what it left behind.
 *
 * The counterpart to the standup. The day view answers "what now"; this answers
 * "did the week go the way it was meant to", which is a question you can only
 * ask once there is a week to look at.
 */
export default function WeekReview({
  weekStart,
  weekEnd,
  thisWeekTransactions,
  lastWeekTransactions,
  liquidWalletIds,
  weeklyGoals,
  lastWeekGoals,
  dailyTasks,
  isDone,
  today,
}) {
  const comparison = compareWeeks(thisWeekTransactions, lastWeekTransactions, liquidWalletIds)
  const days = spendByWeekday(thisWeekTransactions, liquidWalletIds, weekStart, today)
  const unfinished = carriedOver(lastWeekGoals, isDone)

  const weekTasks = dailyTasks.filter((t) => t.target_date >= weekStart && t.target_date <= weekEnd)
  const tasksDone = weekTasks.filter(isDone).length

  // Scale bars against the busiest day, not the week's total, or a normal week
  // renders as seven barely-visible slivers.
  const peak = Math.max(...days.map((d) => d.spent), 0)

  return (
    <div className="space-y-6">
      {/* Where the week went */}
      <section className="bg-card rounded-3xl p-6 border border-white/10 shadow-xl space-y-4">
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">
              This week
            </p>
            <p className="text-3xl font-extrabold text-white tabular-nums">
              {formatNaira(comparison.spent.now)}
            </p>
          </div>
          <Delta change={comparison.spent} lowerIsBetter />
        </div>

        <div className="grid grid-cols-2 gap-2 pt-3 border-t border-white/5">
          <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
            <p className="text-[10px] text-muted uppercase tracking-wider">In</p>
            <p className="text-sm font-bold text-white tabular-nums">
              {formatNaira(comparison.income.now)}
            </p>
          </div>
          <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
            <p className="text-[10px] text-muted uppercase tracking-wider">Moved aside</p>
            <p className="text-sm font-bold text-blue-400 tabular-nums">
              {formatNaira(comparison.movedAside.now)}
            </p>
          </div>
        </div>
      </section>

      {/* Rhythm — which days the money left on */}
      <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Rhythm</h2>

        {peak === 0 ? (
          <p className="text-xs text-muted py-2">Nothing spent yet this week.</p>
        ) : (
          <div className="flex items-end justify-between gap-2 h-28">
            {days.map((day) => (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-1.5 h-full">
                <div className="flex-1 w-full flex items-end">
                  <div
                    className={`w-full rounded-t-md transition-all ${
                      day.isFuture ? 'bg-white/5' : day.isToday ? 'bg-accent' : 'bg-accent/50'
                    }`}
                    // Floored at 2% so a day with a small amount is still a
                    // visible bar rather than nothing; a day with genuinely
                    // nothing stays at zero, because those differ.
                    style={{ height: day.spent > 0 ? `${Math.max(2, (day.spent / peak) * 100)}%` : '0%' }}
                    title={`${day.label} — ${formatNaira(day.spent)}`}
                  />
                </div>
                <span
                  className={`text-[9px] ${day.isToday ? 'text-accent font-bold' : 'text-muted-dim'}`}
                >
                  {day.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Where it went, by category — the same component Budget uses */}
      <CategoryBreakdown byCategory={comparison.byCategory} />

      {/* Weekly targets */}
      {weeklyGoals.length > 0 && (
        <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
              This week's targets
            </h2>
            <Link to="/goals" className="text-xs font-semibold text-accent hover:underline">
              Manage →
            </Link>
          </div>

          <ul className="space-y-2">
            {weeklyGoals.map((goal) => {
              const progress = goalProgress(goal, thisWeekTransactions)
              const met = progress.measured ? progress.met : Boolean(goal.completed)

              return (
                <li
                  key={goal.id}
                  className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-background/50 border border-white/5"
                >
                  <span className={`text-sm min-w-0 truncate ${met ? 'text-muted' : 'text-white'}`}>
                    {goal.title}
                  </span>
                  {progress.measured ? (
                    <span
                      className={`text-xs font-bold tabular-nums flex-shrink-0 ${
                        met ? 'text-accent' : 'text-muted'
                      }`}
                    >
                      {formatNaira(progress.done)} / {formatNaira(progress.target)}
                    </span>
                  ) : (
                    <span className="text-xs flex-shrink-0" aria-hidden="true">
                      {met ? '✅' : '⬜'}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* Days planned and finished */}
      {weekTasks.length > 0 && (
        <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-2">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Tasks</h2>
          <p className="text-lg font-bold text-white tabular-nums">
            {tasksDone}
            <span className="text-muted text-xs font-normal">
              /{weekTasks.length} finished this week
            </span>
          </p>
        </section>
      )}

      {/* Carried over — named rather than quietly dropped */}
      {unfinished.length > 0 && (
        <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
            Carried over from last week
          </h2>
          <ul className="space-y-2">
            {unfinished.map((goal) => (
              <li
                key={goal.id}
                className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-orange-500/10 border border-orange-500/20"
              >
                <span className="text-sm text-orange-200 min-w-0 truncate">{goal.title}</span>
                <span className="text-[10px] text-orange-300/70 flex-shrink-0">
                  {formatDate(goal.target_date)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
