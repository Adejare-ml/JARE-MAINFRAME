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
import Icon from '../ui/Icon'
import IconButton from '../ui/IconButton'
import Button from '../ui/Button'
import Badge from '../ui/Badge'
import StatusDot from '../ui/StatusDot'
import { resolveIcon } from '../../lib/constants'

/** Funded fractions that get a brief celebration when crossed during a session. */
const MILESTONES = [0.25, 0.5, 0.75, 1]

/** Commit subjects shown as evidence. Enough to recognise the work, not a log. */
const EVIDENCE_SHOWN = 3

/**
 * One monthly or weekly goal, with what it is asking for next.
 *
 * A measured goal shows a bar it filled in itself, from the transactions the
 * bank-alert ingestion recorded -- and says where the number came from, because a figure
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
export default function TargetCard({ goal, transactions = [], liquidWalletIds = null, today, onEdit, onDelete, confirmingDelete }) {
  const progress = goalProgress(goal, transactions, { liquidWalletIds })
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
  // A repo goal nobody has checked yet gets no arc at all: a filled ring at 0%
  // would be the app asserting a result it has not got. Token vars because
  // ProgressRing paints its arc as an inline SVG stroke.
  const ringColor = !progress.checked
    ? 'var(--color-surface-2)'
    : isCap
      ? progress.share > 1 ? 'var(--color-danger)' : progress.share > 0.8 ? 'var(--color-warn)' : 'var(--color-accent)'
      : 'var(--color-accent)'

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

  // A locked goal's delete needs a second, explicit acknowledgement, not just
  // the ordinary two-tap confirm every goal already gets. Reset whenever the
  // confirm panel closes, so re-opening it never starts pre-checked.
  const [lockAcknowledged, setLockAcknowledged] = useState(false)
  useEffect(() => {
    if (!confirmingDelete) setLockAcknowledged(false)
  }, [confirmingDelete])

  return (
    <li className={`px-3 py-3 lg:px-4 space-y-3 ${goal.locked ? 'border-l-2 border-l-warn' : ''} ${celebrate ? 'animate-milestone' : ''}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 mt-0.5 rounded-chip bg-surface-2 text-muted shrink-0">
          <Icon name={resolveIcon(goal.icon, 'goal')} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 min-w-0">
            <span className="text-heading text-foreground truncate">{goal.title}</span>
            {goal.locked && (
              <span title="Locked: confirms before early deletion" className="inline-flex shrink-0 text-warn">
                <Icon name="lock" size={16} title="Locked" />
              </span>
            )}
            {goal.generated === true && <Badge label="Derived" />}
          </p>
          <p className="text-body-sm text-muted truncate">
            {goal.period === 'monthly' ? 'This month' : 'This week'}
            {periodsLeft != null && ` · ${periodsLeft} week${periodsLeft === 1 ? '' : 's'} left`}
            {goal.metric_category && ` · ${goal.metric_category}`}
          </p>
        </div>
        <div className="flex -mr-3 -my-1.5 shrink-0">
          <IconButton name="edit" label={`Edit ${goal.title}`} onClick={() => onEdit(goal)} />
          <IconButton name="trash" label={`Delete ${goal.title}`} onClick={() => onDelete(goal.id)} />
        </div>
      </div>

      {progress.measured ? (
        <>
          <div className="flex items-center gap-3">
            <ProgressRing value={progress.checked ? progress.share : 0} size={56} strokeWidth={5} color={ringColor}>
              <span className="type-data text-foreground">
                {Math.round(Math.min(100, progress.share * 100))}%
              </span>
            </ProgressRing>
            <div className="min-w-0 flex-1">
              {/* money only when the metric actually is one -- a repo goal's
                  figure is a commit count, and blurring that under zen mode
                  would hide a number that was never financial. */}
              <p className="whitespace-nowrap">
                <span className={`text-heading font-semibold text-foreground font-sans tabular-nums ${isRepo ? '' : 'money'}`}>
                  {formatGoalAmount(progress.done, goal.metric)}
                </span>
                <span className={`text-body-sm text-muted font-sans ${isRepo ? '' : 'money'}`}>
                  {' '}
                  of {formatGoalAmount(progress.target, goal.metric)}
                </span>
              </p>
              {/* Where the number came from. Without this it is just a number. */}
              <p className="type-data text-muted-dim">{progress.source}</p>
              {projectedDate && (
                <p className="type-data text-muted-dim">At this pace: {formatDate(projectedDate)}</p>
              )}
            </div>
          </div>

          {/* The commits themselves. This is the difference between a claim and
              a receipt: the figure above was written by a scheduled job the
              browser cannot re-run, so it has to be checkable by eye. */}
          {commits.length > 0 && (
            <ul className="space-y-0.5">
              {commits.slice(0, EVIDENCE_SHOWN).map((c) => (
                <li key={c.sha} className="text-body-sm text-muted-dim truncate">
                  <span className="type-data text-muted">{String(c.sha).slice(0, 7)}</span> {c.message}
                </li>
              ))}
              {commits.length > EVIDENCE_SHOWN && (
                <li className="text-body-sm text-muted-dim">and {commits.length - EVIDENCE_SHOWN} more</li>
              )}
            </ul>
          )}

          {/* Checked and empty is not missed. Saying nothing here would leave a
              0% bar to imply a verdict the verifier never reached. */}
          {isRepo && progress.checked && progress.done === 0 && (
            <p className="text-body-sm text-muted">
              No commits in this period. If the work happened elsewhere, tick it off.
            </p>
          )}
        </>
      ) : (
        <p className="text-body-sm text-muted">
          A reminder, with nothing to measure it against, so you tick this one yourself.
        </p>
      )}

      {/* What a plan you approved said this period was about. Above `next`,
          because the words are the plan and the number is only its size. The
          citation is shown, not hidden: a plan item the model wrote is still
          a change worth being able to check, not just words to take on faith. */}
      {goal.focus && (
        <div className="border-t border-border pt-2.5 space-y-1">
          <p className="text-body-sm text-foreground">{goal.focus}</p>
          {goal.plan_evidence?.cites && (
            <p className="type-data text-muted-dim truncate" title={goal.plan_evidence.cites}>
              From: {goal.plan_evidence.cites}
            </p>
          )}
        </div>
      )}

      {next && (
        <p className={`text-body-sm text-foreground ${goal.focus ? '' : 'border-t border-border pt-2.5'}`}>
          <span className="text-muted">Next: </span>
          {next.title}
        </p>
      )}

      {progress.measured && progress.met && (
        <p className="flex items-center gap-2 text-body-sm text-accent font-semibold">
          <StatusDot status="ok" />
          {isCap ? 'Still under' : 'Done'}
        </p>
      )}

      {/* Ticked by hand on top of the evidence, not instead of it -- the count
          above stays whatever the repository actually said. */}
      {isRepo && !progress.met && goal.completed && (
        <p className="flex items-center gap-2 text-body-sm text-accent font-semibold">
          <StatusDot status="ok" />
          Marked done by you
        </p>
      )}

      {confirmingDelete && (
        <div role="alert" className="border-t border-border pt-3 space-y-2">
          <p className="text-body-sm text-danger">
            {goal.locked
              ? 'This goal is locked: money set aside for it is not meant to come out early.'
              : 'Delete this goal? Anything it generated goes with it.'}
          </p>
          {goal.locked && (
            <label className="flex items-center gap-3 min-h-12 text-body-sm text-foreground">
              <input
                type="checkbox"
                checked={lockAcknowledged}
                onChange={(e) => setLockAcknowledged(e.target.checked)}
                className="w-5 h-5"
                style={{ accentColor: 'var(--color-danger)' }}
              />
              I understand, delete it anyway
            </label>
          )}
          <div className="flex gap-2">
            <Button
              variant="danger"
              className="flex-1"
              onClick={() => onDelete(goal.id, true)}
              disabled={goal.locked && !lockAcknowledged}
            >
              Delete
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => onDelete(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}
