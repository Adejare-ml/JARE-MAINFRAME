import { formatDate } from '../../lib/formatters'
import CategoryBreakdown from '../ui/CategoryBreakdown'
import { spendByWeekday, compareWeeks, carriedOver } from '../../lib/weekreview'
import { goalProgress } from '../../lib/planning'
import WeekRecap from './WeekRecap'
import Panel from '../ui/Panel'
import Readout from '../ui/Readout'
import Stat from '../ui/Stat'
import Money from '../ui/Money'
import Button from '../ui/Button'
import Icon from '../ui/Icon'
import StatusDot from '../ui/StatusDot'
import ListRow, { ListRows } from '../ui/ListRow'

/** A signed change, coloured by whether it is good news rather than by sign. */
function Delta({ change, lowerIsBetter }) {
  if (change.delta === 0) return <span className="text-body-sm text-muted">Same as last week</span>

  const up = change.delta > 0
  const good = lowerIsBetter ? !up : up
  const pct = change.share == null ? null : Math.abs(Math.round(change.share * 100))

  return (
    <span className={`inline-flex items-center gap-1 text-body-sm font-medium ${good ? 'text-accent' : 'text-warn'}`}>
      <Icon name={up ? 'arrowOut' : 'arrowIn'} size={14} />
      <Money amount={Math.abs(change.delta)} kobo={false} tone={good ? 'positive' : 'warn'} />
      {/* No percentage when last week was zero: "up 100%" from nothing is a
          division that completed, not a fact worth printing. */}
      {pct != null && <span className="type-data text-muted">{pct}%</span>}
      <span className="sr-only">{up ? 'more' : 'less'} than last week</span>
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
  lastWeekStart,
  thisWeekTransactions,
  lastWeekTransactions,
  liquidWalletIds,
  weeklyGoals,
  lastWeekGoals,
  dailyTasks,
  isDone,
  isLastWeekGoalDone,
  today,
}) {
  const comparison = compareWeeks(thisWeekTransactions, lastWeekTransactions, liquidWalletIds)
  const days = spendByWeekday(thisWeekTransactions, liquidWalletIds, weekStart, today)
  // A weekly goal is judged on its whole week, not on its Monday: isDone
  // filters transactions to the task's own target_date, which for a weekly
  // row is the week's first day, so a spending cap with nothing spent on
  // Monday read as met and was never carried over.
  const unfinished = carriedOver(lastWeekGoals, isLastWeekGoalDone || isDone)

  const weekTasks = dailyTasks.filter((t) => t.target_date >= weekStart && t.target_date <= weekEnd)
  const tasksDone = weekTasks.filter(isDone).length

  // Scale bars against the busiest day, not the week's total, or a normal week
  // renders as seven barely-visible slivers.
  const peak = Math.max(...days.map((d) => d.spent), 0)

  return (
    <div className="space-y-3">
      {/* Where the week went */}
      <Panel label="This week" meta={`${formatDate(weekStart)} to ${formatDate(weekEnd)}`}>
        <Readout size="figure" value={comparison.spent.now} sub={<Delta change={comparison.spent} lowerIsBetter />} />
        <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-border">
          <Stat label="In" value={<Money amount={comparison.income.now} kobo={false} />} />
          <Stat label="Moved aside" value={<Money amount={comparison.movedAside.now} kobo={false} />} />
        </div>
      </Panel>

      {/* Rhythm: which days the money left on */}
      <Panel label="Rhythm">
        {peak === 0 ? (
          <p className="text-body-sm text-muted">Nothing spent yet this week.</p>
        ) : (
          <div className="flex items-end justify-between gap-2 h-28">
            {days.map((day) => (
              <div key={day.date} className="flex-1 flex flex-col items-center gap-1.5 h-full">
                <div className="flex-1 w-full flex items-end">
                  <div
                    className={`w-full rounded-t-[2px] ${day.isFuture ? 'bg-surface-2' : day.isToday ? 'bg-accent' : 'bg-border-strong'}`}
                    // Floored at 2% so a small amount is still a visible bar;
                    // a day with genuinely nothing stays at zero.
                    style={{ height: day.spent > 0 ? `${Math.max(2, (day.spent / peak) * 100)}%` : '0%' }}
                    // The label only, not the amount: a native `title` is
                    // browser-rendered text zen mode cannot blur.
                    title={day.label}
                  />
                </div>
                <span className={`type-data text-xs ${day.isToday ? 'text-foreground font-medium' : 'text-muted-dim'}`}>{day.label}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Where it went, by category: the same component Budget uses */}
      <CategoryBreakdown byCategory={comparison.byCategory} />

      {/* Weekly targets */}
      {weeklyGoals.length > 0 && (
        <Panel label="This week's targets" flush action={<Button size="sm" variant="ghost" to="/goals">Manage</Button>}>
          <ListRows>
            {weeklyGoals.map((goal) => {
              const progress = goalProgress(goal, thisWeekTransactions)
              const met = progress.measured ? progress.met : Boolean(goal.completed)
              return (
                <ListRow
                  key={goal.id}
                  leading={<StatusDot status={met ? 'ok' : 'muted'} />}
                  title={goal.title}
                  subtitle={met ? 'Met' : 'Open'}
                  trailing={
                    progress.measured ? (
                      <span className="whitespace-nowrap text-body-sm text-muted">
                        <Money amount={progress.done} kobo={false} tone={met ? 'positive' : 'default'} /> of{' '}
                        <Money amount={progress.target} kobo={false} tone="muted" />
                      </span>
                    ) : null
                  }
                />
              )
            })}
          </ListRows>
        </Panel>
      )}

      {/* Days planned and finished */}
      {weekTasks.length > 0 && (
        <Panel label="Tasks">
          <Readout kind="number" value={tasksDone} unit={`of ${weekTasks.length} finished this week`} />
        </Panel>
      )}

      {/* Written the Monday after this week's predecessor closed -- see
          WeekRecap.jsx for why it is always about last week. */}
      <WeekRecap weekStart={lastWeekStart} />

      {/* Carried over: named rather than quietly dropped */}
      {unfinished.length > 0 && (
        <Panel label="Carried over from last week" tone="warn" flush>
          <ListRows>
            {unfinished.map((goal) => (
              <ListRow
                key={goal.id}
                leading={<StatusDot status="warn" />}
                title={goal.title}
                trailing={<span className="type-data text-muted-dim">{formatDate(goal.target_date)}</span>}
              />
            ))}
          </ListRows>
        </Panel>
      )}
    </div>
  )
}
