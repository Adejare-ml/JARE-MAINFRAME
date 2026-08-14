import { useState } from 'react'
import { formatNaira } from '../../lib/formatters'
import { goalProgress, GENERATED_SLOT_BASE } from '../../lib/planning'

/**
 * Today's tasks — the ones you typed and the ones the app derived — in one list
 * you can tick without leaving the page.
 *
 * Until now the priorities lived in three text inputs here and the checkboxes
 * lived on a different page, so setting a priority and completing it were two
 * separate journeys. That split is what this replaces.
 *
 * Three kinds of row, and they behave differently on purpose:
 *
 *   typed      tap the text to edit, tap the box to tick
 *   derived    tap the box to tick; the text is not yours to edit, and says
 *              which goal produced it
 *   measured   no box at all. The ledger decides, and offering a checkbox would
 *              invite you to claim something the transactions do not support.
 */
export default function TodayList({
  tasks,
  transactions,
  busyId,
  onToggle,
  onSaveTitle,
  onDelete,
  canAdd,
}) {
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')

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

  return (
    <ul className="space-y-2">
      {tasks.map((task) => {
        const progress = goalProgress(task, transactions)
        const derived = task.generated === true || (task.slot ?? 0) >= GENERATED_SLOT_BASE

        // ── Measured: the ledger answers, so there is nothing to tick ──
        if (progress.measured) {
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
                  {formatNaira(progress.done)} of {formatNaira(progress.target)} · {progress.source}
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

        // ── Tickable: typed, or derived-but-not-measured ──
        return (
          <li
            key={task.id}
            className="flex items-center gap-2 p-3 rounded-2xl bg-background/50 border border-white/5 min-h-[48px]"
          >
            <button
              type="button"
              onClick={() => onToggle(task)}
              disabled={busyId === task.id}
              aria-pressed={Boolean(task.completed)}
              aria-label={task.completed ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`}
              className="flex-shrink-0 disabled:opacity-60"
            >
              <span
                className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center text-xs font-bold transition-colors ${
                  task.completed
                    ? 'bg-accent border-accent text-black'
                    : 'border-white/20 text-transparent'
                }`}
                aria-hidden="true"
              >
                ✓
              </span>
            </button>

            {derived ? (
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm ${task.completed ? 'text-muted line-through' : 'text-white'}`}
                >
                  {task.title}
                </span>
                {/* Why this is on your list. A task nobody typed has to account
                    for itself, or it reads as the app inventing work. */}
                <span className="block text-[10px] text-muted-dim mt-0.5">From a goal</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => startEdit(task)}
                className="min-w-0 flex-1 text-left"
              >
                <span
                  className={`block text-sm ${task.completed ? 'text-muted line-through' : 'text-white'}`}
                >
                  {task.title}
                </span>
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
