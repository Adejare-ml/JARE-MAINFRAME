import { formatGoalAmount } from '../../lib/formatters'
import {
  goalProgress,
  weeksRemaining,
  decomposeMonthly,
  decomposeWeekly,
  REPO_METRIC,
} from '../../lib/planning'
import { endOfMonth } from '../../lib/queries'

/** Commit subjects shown as evidence. Enough to recognise the work, not a log. */
const EVIDENCE_SHOWN = 3

/**
 * One monthly or weekly goal, with what it is asking for next.
 *
 * A measured goal shows a bar it filled in itself, from the transactions the
 * Gmail sync imported -- and says where the number came from, because a figure
 * the app computed has to be able to explain itself. A `manual` goal has no bar
 * to show, and says that rather than rendering an empty one at 0%.
 *
 * A repo goal is the one that cannot fill itself in here: the browser has no
 * GitHub credentials, so the figure was written by a nightly Action and this is
 * reading it back. That makes two things load-bearing which the money goals
 * never needed. The card must distinguish *nobody has checked* from *checked
 * and found nothing* -- and when it has found something it shows the commits,
 * because a number the app cannot recompute has to be auditable.
 */
export default function TargetCard({ goal, transactions = [], today, onEdit, onDelete, confirmingDelete }) {
  const progress = goalProgress(goal, transactions)
  const next = goal.period === 'monthly'
    ? decomposeMonthly(goal, progress, today)
    : decomposeWeekly(goal, progress, today)

  const periodsLeft = goal.period === 'monthly'
    ? weeksRemaining(endOfMonth(new Date(`${goal.target_date}T00:00:00`)), today)
    : null

  const isCap = goal.metric === 'spend_under'
  const isRepo = goal.metric === REPO_METRIC
  const commits = isRepo && Array.isArray(goal.evidence?.commits) ? goal.evidence.commits : []

  // A cap is healthy while it is low and a savings goal while it is high, so
  // the same percentage means opposite things and cannot share a colour rule.
  // A repo goal nobody has checked yet gets neither: an accent bar at 0% would
  // be the app asserting a result it has not got.
  const barColor = !progress.measured
    ? 'bg-white/20'
    : !progress.checked
      ? 'bg-white/10'
      : isCap
        ? progress.share > 1 ? 'bg-red-500' : progress.share > 0.8 ? 'bg-yellow-500' : 'bg-accent'
        : progress.met ? 'bg-accent' : 'bg-accent/60'

  return (
    <div className="bg-background/50 border border-white/5 rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white truncate">{goal.title}</p>
          <p className="text-[11px] text-muted mt-0.5">
            {goal.period === 'monthly' ? 'This month' : 'This week'}
            {periodsLeft != null && ` · ${periodsLeft} week${periodsLeft === 1 ? '' : 's'} left`}
            {goal.metric_category && ` · ${goal.metric_category}`}
          </p>
        </div>
        <div className="flex gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => onEdit(goal)}
            aria-label={`Edit ${goal.title}`}
            className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-muted hover:text-white"
          >
            ✏️
          </button>
          <button
            type="button"
            onClick={() => onDelete(goal.id)}
            aria-label={`Delete ${goal.title}`}
            className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-red-500/10 text-muted hover:text-red-400"
          >
            🗑️
          </button>
        </div>
      </div>

      {progress.measured ? (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-lg font-bold text-white tabular-nums">
              {formatGoalAmount(progress.done, goal.metric)}
              <span className="text-muted text-xs font-normal">
                {' '}
                of {formatGoalAmount(progress.target, goal.metric)}
              </span>
            </p>
            <p className={`text-xs font-bold tabular-nums ${progress.met ? 'text-accent' : 'text-muted'}`}>
              {Math.round(progress.share * 100)}%
            </p>
          </div>

          <div className="h-2 bg-white/5 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${barColor}`}
              style={{ width: `${Math.min(100, Math.round(progress.share * 100))}%` }}
            />
          </div>

          {/* Where the number came from. Without this it is just a number. */}
          <p className="text-[10px] text-muted-dim">{progress.source}</p>

          {/* The commits themselves. This is the difference between a claim and
              a receipt: the figure above was written by a scheduled job the
              browser cannot re-run, so it has to be checkable by eye. */}
          {commits.length > 0 && (
            <ul className="space-y-0.5 pt-0.5">
              {commits.slice(0, EVIDENCE_SHOWN).map((c) => (
                <li key={c.sha} className="text-[10px] text-muted-dim truncate">
                  <span className="font-mono text-muted">{String(c.sha).slice(0, 7)}</span>{' '}
                  {c.message}
                </li>
              ))}
              {commits.length > EVIDENCE_SHOWN && (
                <li className="text-[10px] text-muted-dim">
                  and {commits.length - EVIDENCE_SHOWN} more
                </li>
              )}
            </ul>
          )}

          {/* Checked and empty is not missed. Saying nothing here would leave a
              0% bar to imply a verdict the verifier never reached. */}
          {isRepo && progress.checked && progress.done === 0 && (
            <p className="text-[11px] text-muted">
              No commits in this period. If the work happened elsewhere, tick it off.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted">
          A reminder — nothing to measure it against, so you tick this one yourself.
        </p>
      )}

      {next && (
        <p className="text-xs text-white/70 border-t border-white/5 pt-2.5">
          <span className="text-muted">Next: </span>
          {next.title}
        </p>
      )}

      {progress.measured && progress.met && (
        <p className="text-xs text-accent font-semibold">
          {isCap ? 'Still under ✓' : 'Done ✓'}
        </p>
      )}

      {/* Ticked by hand on top of the evidence, not instead of it -- the count
          above stays whatever the repository actually said. */}
      {isRepo && !progress.met && goal.completed && (
        <p className="text-xs text-accent font-semibold">Marked done by you ✓</p>
      )}

      {confirmingDelete && (
        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
          <p className="text-xs text-red-400 mb-2">
            Delete this goal? Anything it generated goes with it.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onDelete(goal.id, true)}
              className="flex-1 py-2.5 bg-red-500 text-white text-xs font-bold rounded-lg min-h-[44px]"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => onDelete(null)}
              className="flex-1 py-2.5 bg-white/5 text-muted text-xs font-bold rounded-lg min-h-[44px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
