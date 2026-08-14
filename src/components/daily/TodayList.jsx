import { useState } from 'react'
import { formatGoalAmount } from '../../lib/formatters'
import { goalProgress, GENERATED_SLOT_BASE } from '../../lib/planning'

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

  return (
    <ul className="space-y-2">
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
            <li
              key={task.id}
              className="flex items-start gap-3 p-3 rounded-2xl bg-background/50 border border-white/5 min-h-[48px]"
            >
              <span
                className={`w-6 h-6 rounded-lg flex-shrink-0 flex items-center justify-center text-xs font-bold mt-0.5 ${
                  progress.met ? 'bg-accent text-black' : 'border-2 border-white/20 text-transparent'
                }`}
                aria-hidden="true"
              >
                ✓
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm ${progress.met ? 'text-muted line-through' : 'text-white'}`}
                >
                  {task.title}
                </span>
                <span className="block text-[10px] text-muted-dim mt-0.5">
                  {formatGoalAmount(progress.done, task.metric)} of{' '}
                  {formatGoalAmount(progress.target, task.metric)} · {progress.source}
                </span>
              </span>
            </li>
          )
        }

        // ── Editing a typed task ──
        if (editingId === task.id) {
          return (
            <li key={task.id}>
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
                className="w-full px-4 py-3 bg-background border border-accent rounded-2xl text-white text-sm placeholder-hint focus:outline-none min-h-[48px]"
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
          <li
            key={task.id}
            className="p-3 rounded-2xl bg-background/50 border border-white/5 space-y-2"
          >
            <div className="flex items-center gap-2 min-h-[24px]">
              <button
                type="button"
                onClick={() => onToggle(task)}
                disabled={busyId === task.id || evidenceDone}
                aria-pressed={done}
                aria-label={done ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`}
                className="flex-shrink-0 disabled:opacity-60"
              >
                <span
                  className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center text-xs font-bold transition-colors ${
                    done ? 'bg-accent border-accent text-black' : 'border-white/20 text-transparent'
                  }`}
                  aria-hidden="true"
                >
                  ✓
                </span>
              </button>

              {derived ? (
                <span className="min-w-0 flex-1">
                  <span className={`block text-sm ${done ? 'text-muted line-through' : 'text-white'}`}>
                    {task.title}
                  </span>
                  {/* Why this is on your list, and what it knows. A task nobody
                      typed has to account for itself, or it reads as the app
                      inventing work. */}
                  <span className="block text-[10px] text-muted-dim mt-0.5">
                    {/* A plan you approved says what this is about; otherwise
                        all a derived task can say for itself is where it came
                        from. Either way it accounts for itself, or it reads as
                        the app inventing work. */}
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
                  className="min-w-0 flex-1 text-left"
                >
                  <span className={`block text-sm ${done ? 'text-muted line-through' : 'text-white'}`}>
                    {task.title}
                  </span>
                </button>
              )}
            </div>

            {task.blocked_reason && reasonId !== task.id && (
              <p className="text-[11px] text-muted pl-8">
                <span className="text-muted-dim">Why not: </span>
                {task.blocked_reason}
              </p>
            )}

            {askWhy && reasonId === task.id && (
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
                placeholder="Office work overran…"
                aria-label="What got in the way?"
                className="w-full px-4 py-2.5 bg-background border border-accent rounded-xl text-white text-xs placeholder-hint focus:outline-none min-h-[44px]"
              />
            )}

            {askWhy && reasonId !== task.id && onSaveReason && (
              <button
                type="button"
                onClick={() => {
                  setReasonId(task.id)
                  setReasonDraft(task.blocked_reason || '')
                }}
                className="text-[11px] text-muted hover:text-white underline underline-offset-2 pl-8"
              >
                {task.blocked_reason ? 'Change why' : 'Say what got in the way'}
              </button>
            )}
          </li>
        )
      })}

      {adding && (
        <li>
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
            className="w-full px-4 py-3 bg-background border border-accent rounded-2xl text-white text-sm placeholder-hint focus:outline-none min-h-[48px]"
          />
        </li>
      )}

      {canAdd && !adding && (
        <li>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="w-full flex items-center gap-3 p-3 rounded-2xl border border-dashed border-white/10 text-muted hover:text-white hover:border-white/20 transition-colors min-h-[48px] text-left text-sm"
          >
            <span className="w-6 h-6 flex items-center justify-center text-base" aria-hidden="true">
              ＋
            </span>
            Add a priority
          </button>
        </li>
      )}

      {tasks.length === 0 && !adding && !canAdd && (
        <li className="text-xs text-muted py-4 text-center">Nothing planned for today.</li>
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
