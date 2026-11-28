import { useState } from 'react'
import { formatGoalAmount } from '../../lib/formatters'
import { goalProgress, GENERATED_SLOT_BASE } from '../../lib/planning'
import TaskCheck from './TaskCheck'
import { useNewIds } from './useNewIds'
import Button from '../ui/Button'
import Icon from '../ui/Icon'
import { controlClasses } from '../ui/Field'

/**
 * Today's tasks — the ones you typed and the ones the app derived — in one list
 * you can tick without leaving the page.
 *
 * Until now the priorities lived in three text inputs here and the checkboxes
 * lived on a different page, so setting a priority and completing it were two
 * separate journeys. That split is what this replaces.
 *
 * Four kinds of row, and they behave differently on purpose:
 *
 *   typed      tap the text to edit, tap the box to tick
 *   derived    tap the box to tick; the text is not yours to edit, and says
 *              which goal produced it
 *   measured   no box at all. The ledger decides, and offering a checkbox would
 *              invite you to claim something the transactions do not support.
 *   verified   measured against a repository, and still tickable — because the
 *              evidence can be absent for work that genuinely happened. This is
 *              also the only row that asks a question back: when the check ran
 *              and found nothing, it offers somewhere to say why.
 */
export default function TodayList({
  tasks,
  transactions,
  busyId,
  onToggle,
  onSaveTitle,
  onDelete,
  onSaveReason,
  canAdd,
}) {
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [reasonId, setReasonId] = useState(null)
  const [reasonDraft, setReasonDraft] = useState('')

  const startEdit = (task) => {
    setEditingId(task.id)
    setDraft(task.title || '')
  }

  const commitEdit = (task) => {
    const title = draft.trim()
    setEditingId(null)
    if (title === (task.title || '').trim()) return
    // Clearing the text is how a priority is removed -- the same gesture the
    // old three-box form used, where blanking an input deleted that slot.
    if (title === '') onDelete(task)
    else onSaveTitle(task, title)
  }

  const commitNew = () => {
    const title = newTitle.trim()
    setAdding(false)
    setNewTitle('')
    if (title) onSaveTitle(null, title)
  }

  const commitReason = (task) => {
    const reason = reasonDraft.trim()
    setReasonId(null)
    setReasonDraft('')
    if (reason !== (task.blocked_reason || '')) onSaveReason?.(task, reason || null)
  }

  // A task added while the page is open fades and moves 4px in; the first
  // render's tasks do not.
  const isNew = useNewIds(tasks.map((t) => t.id))
  const enter = (task) => (isNew(task.id) ? 'row-enter' : '')

  const titleClass = (done) => `block text-body ${done ? 'text-muted line-through' : 'text-foreground'}`

  return (
    <ul className="divide-y divide-border border-t border-border">
      {tasks.map((task) => {
        const progress = goalProgress(task, transactions)
        const derived = task.generated === true || (task.slot ?? 0) >= GENERATED_SLOT_BASE

        // ── Measured: the ledger answers, so there is nothing to tick ──
        //
        // `overridable` is what separates this from a repo task below. Money
        // either moved or it did not; code work can happen somewhere a commit
        // would never show it, so that one keeps its checkbox.
        if (progress.measured && !progress.overridable) {
          return (
            <li key={task.id} className={`flex items-start gap-2 px-3 min-h-14 ${enter(task)}`}>
              <TaskCheck done={progress.met} locked />
              <span className="min-w-0 flex-1 py-2">
                <span className={titleClass(progress.met)}>{task.title}</span>
                {/* Inter, not mono: the line carries ₦ figures, and mono never renders ₦. */}
                <span className="block text-body-sm text-muted mt-0.5">
                  {formatGoalAmount(progress.done, task.metric)} of {formatGoalAmount(progress.target, task.metric)} · {progress.source}
                </span>
              </span>
            </li>
          )
        }

        // ── Editing a typed task ──
        if (editingId === task.id) {
          return (
            <li key={task.id} className="px-3 py-2">
              <input
                autoFocus
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitEdit(task)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                aria-label="Edit priority"
                className={controlClasses()}
              />
            </li>
          )
        }

        // ── Tickable: typed, derived-but-not-measured, or repo-verified ──
        // Two different sources of "done", and only one of them is yours to
        // change. `progress.met` on a typed task just means the box is ticked,
        // so locking the box on it would make a ticked priority impossible to
        // untick -- the measurement has to be what locks it, not the tick.
        const evidenceDone = progress.measured && progress.met
        const done = evidenceDone || Boolean(task.completed)
        // A repo task that was checked and came back empty is the one place
        // this list asks a question rather than just reporting. Not offered
        // before the check has run: there would be nothing to explain yet.
        const askWhy =
          progress.overridable &&
          progress.measured &&
          progress.checked &&
          !progress.met &&
          !task.completed

        return (
          <li key={task.id} className={`px-3 ${enter(task)}`}>
            <div className="flex items-center gap-2 min-h-12">
              <TaskCheck
                done={done}
                onClick={() => onToggle(task)}
                disabled={busyId === task.id || evidenceDone}
                label={done ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`}
              />

              {derived ? (
                <span className="min-w-0 flex-1 py-2">
                  <span className={titleClass(done)}>{task.title}</span>
                  {/* Why this is on your list, and what it knows. A task nobody
                      typed has to account for itself, or it reads as the app
                      inventing work. */}
                  <span className="block text-body-sm text-muted mt-0.5">
                    {task.focus ||
                      (progress.overridable && progress.measured
                        ? repoLine(progress, task)
                        : 'From a goal')}
                  </span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => startEdit(task)}
                  className="min-w-0 flex-1 text-left min-h-12"
                >
                  <span className={titleClass(done)}>{task.title}</span>
                </button>
              )}
            </div>

            {task.blocked_reason && reasonId !== task.id && (
              <p className="text-body-sm text-muted pl-9 pb-2">
                <span className="text-muted-dim">Why not: </span>
                {task.blocked_reason}
              </p>
            )}

            {askWhy && reasonId === task.id && (
              <div className="pb-2">
                <input
                  autoFocus
                  type="text"
                  value={reasonDraft}
                  onChange={(e) => setReasonDraft(e.target.value)}
                  onBlur={() => commitReason(task)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setReasonId(null)
                  }}
                  placeholder="Office work overran"
                  aria-label="What got in the way?"
                  className={controlClasses()}
                />
              </div>
            )}

            {askWhy && reasonId !== task.id && onSaveReason && (
              <div className="pl-6 pb-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setReasonId(task.id)
                    setReasonDraft(task.blocked_reason || '')
                  }}
                  aria-label={task.blocked_reason ? 'Change reason for not completing' : 'Add reason for not completing'}
                >
                  {task.blocked_reason ? 'Change why' : 'Say what got in the way'}
                </Button>
              </div>
            )}
          </li>
        )
      })}

      {adding && (
        <li className="px-3 py-2">
          <input
            autoFocus
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onBlur={commitNew}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setNewTitle('')
                setAdding(false)
              }
            }}
            placeholder="What matters today?"
            aria-label="New priority"
            className={controlClasses()}
          />
        </li>
      )}

      {canAdd && !adding && (
        <li>
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label="Add a new priority"
            className="w-full flex items-center gap-2 px-3 min-h-12 text-body text-muted hover:text-foreground hover:bg-surface-2 transition-colors duration-150 text-left"
          >
            <span className="w-6 flex justify-center">
              <Icon name="plus" size={18} />
            </span>
            Add a priority
          </button>
        </li>
      )}

      {tasks.length === 0 && !adding && !canAdd && (
        <li className="px-3 py-3 text-body-sm text-muted">Nothing planned for today.</li>
      )}
    </ul>
  )
}

/**
 * What a repo-verified task knows about itself, in one line.
 *
 * The three states are kept apart deliberately. "Not checked yet" is not a
 * verdict, and "nothing landed" is not a failure -- an afternoon of reviews or
 * office work produces no commits and is still a day's work. Writing either of
 * them as "0 of 2" and leaving it there would let the reader supply the missing
 * word themselves, and the word they would supply is "missed".
 */
function repoLine(progress, task) {
  if (!progress.checked) return 'Checked against the repo tonight'
  if (progress.done === 0) return `No commits yet · ${progress.source}`
  return (
    `${formatGoalAmount(progress.done, task.metric)} of ` +
    `${formatGoalAmount(progress.target, task.metric)} · ${progress.source}`
  )
}
