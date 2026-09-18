import { useEffect, useRef, useState } from 'react'
import { formatGoalAmount, formatDate } from '../../lib/formatters'
import {
  goalProgress,
  weeksRemaining,
  decomposeMonthly,
  decomposeWeekly,
  projectedCompletion,
  REPO_METRIC,
} from '../../lib/planning'
import { endOfMonth } from '../../lib/queries'
import ProgressRing from '../ui/ProgressRing'

/** Funded fractions that get a brief celebration when crossed during a session. */
const MILESTONES = [0.25, 0.5, 0.75, 1]

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
  const projectedDate = projectedCompletion(goal, progress, today)

  // A cap is healthy while it is low and a savings goal while it is high, so
  // the same percentage means opposite things and cannot share a colour rule.
  // A repo goal nobody has checked yet gets neither: a filled ring at 0% would
  // be the app asserting a result it has not got. Hex literals rather than
  // Tailwind classes because ProgressRing paints its arc as an inline SVG
  // stroke -- Budget.jsx's donut (Stage H) sets the same precedent.
  const ringColor = !progress.measured
    ? 'rgba(255,255,255,0.2)'
    : !progress.checked
      ? 'rgba(255,255,255,0.1)'
      : isCap
        ? progress.share > 1 ? '#ef4444' : progress.share > 0.8 ? '#eab308' : 'var(--color-accent)'
        : progress.met ? 'var(--color-accent)' : 'rgba(34,197,94,0.6)'

  // A brief pulse the moment funding crosses 25/50/75/100% -- during THIS
  // session only. Seeded from the value already on screen at mount, so
  // opening a card that is already 80% funded does not celebrate; only
  // watching it move past a line does.
  const [celebrate, setCelebrate] = useState(false)
  const prevShare = useRef(progress.share)
  useEffect(() => {
    const crossed = progress.measured
      && MILESTONES.some((m) => prevShare.current < m && progress.share >= m)
    prevShare.current = progress.share
    if (!crossed) return
    setCelebrate(true)
    const t = setTimeout(() => setCelebrate(false), 900)
    return () => clearTimeout(t)
  }, [progress.share, progress.measured])

  return (
    <div
      className={`bg-background/50 border border-white/5 rounded-2xl p-4 space-y-3 ${
        celebrate ? 'animate-milestone' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-white truncate flex items-center gap-1.5">
            {goal.icon && <span aria-hidden="true">{goal.icon}</span>}
            <span className="truncate">{goal.title}</span>
            {goal.generated === true && (
              <span className="flex-shrink-0 px-1.5 py-0.5 rounded-full bg-white/10 text-muted-dim text-[9px] font-semibold uppercase tracking-wider">
                Derived
              </span>
            )}
          </p>
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
          <div className="flex items-center gap-4">
            <ProgressRing value={progress.share} size={64} strokeWidth={6} color={ringColor}>
              <span className={`text-xs font-bold tabular-nums ${progress.met ? 'text-accent' : 'text-white'}`}>
                {Math.round(Math.min(100, progress.share * 100))}%
              </span>
            </ProgressRing>
            <div className="min-w-0 flex-1">
              <p className="text-lg font-bold text-white tabular-nums">
                {formatGoalAmount(progress.done, goal.metric)}
                <span className="text-muted text-xs font-normal">
                  {' '}
                  of {formatGoalAmount(progress.target, goal.metric)}
                </span>
              </p>
              {/* Where the number came from. Without this it is just a number. */}
              <p className="text-[10px] text-muted-dim mt-0.5">{progress.source}</p>
              {projectedDate && (
                <p className="text-[10px] text-muted-dim mt-0.5">
                  At this pace: {formatDate(projectedDate)}
                </p>
              )}
            </div>
          </div>

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

      {/* What a plan you approved said this period was about. Above `next`,
          because the words are the plan and the number is only its size. */}
      {goal.focus && (
        <p className="text-xs text-white/80 border-t border-white/5 pt-2.5">
          {goal.focus}
          {goal.plan_evidence?.cites && (
            <span className="block text-[10px] text-muted-dim mt-0.5 font-mono">
              {goal.plan_evidence.cites}
            </span>
          )}
        </p>
      )}

      {next && (
        <p className={`text-xs text-white/70 ${goal.focus ? '' : 'border-t border-white/5 pt-2.5'}`}>
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
