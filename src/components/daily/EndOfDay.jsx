import { useState } from 'react'

/**
 * The evening question: what landed, and what did not.
 *
 * It only asks about what is still open, and it asks once. A review that walks
 * you through everything -- including the things that went fine -- is a digital
 * notebook with extra steps, and the guiding rule for this whole subsystem is
 * that the human should only be asked about what genuinely needs judgment.
 * Whether you finished the thing you finished does not.
 *
 * Two answers are offered for each, and they are deliberately different in kind:
 *
 *   Tick it. You did it; the app was simply wrong to still be showing it.
 *
 *   Say what got in the way. You did not, and the reason is the only part worth
 *   reading back at the end of a month. `blocked_reason` arrived with 010 for
 *   repo tasks and this is where it earns its keep for everything else -- a bare
 *   miss teaches nothing, "the client review overran" teaches you your Tuesdays
 *   are not what you think they are.
 *
 * There is no third option and no "skip all". Leaving it alone is already the
 * default: close the page and nothing is recorded, which is honest, because
 * nothing was.
 */
export default function EndOfDay({ open, onToggle, onSaveReason, busyId }) {
  const [reasonId, setReasonId] = useState(null)
  const [draft, setDraft] = useState('')

  if (!open || open.length === 0) return null

  const commit = (task) => {
    const reason = draft.trim()
    setReasonId(null)
    setDraft('')
    if (reason && reason !== (task.blocked_reason || '')) onSaveReason(task, reason)
  }

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
      <div>
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
          Before you close
        </h2>
        <p className="text-xs text-muted mt-1.5">
          {open.length} thing{open.length === 1 ? '' : 's'} still open. Tick what landed; say
          what got in the way of the rest.
        </p>
      </div>

      <ul className="space-y-2">
        {open.map((task) => (
          <li
            key={task.id}
            className="bg-background/50 border border-white/5 rounded-2xl p-3 space-y-2"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggle(task)}
                disabled={busyId === task.id}
                aria-label={`Mark "${task.title}" done`}
                className="flex-shrink-0 disabled:opacity-60"
              >
                <span
                  className="w-6 h-6 rounded-lg border-2 border-white/20 flex items-center justify-center text-xs font-bold text-transparent"
                  aria-hidden="true"
                >
                  ✓
                </span>
              </button>
              <span className="min-w-0 flex-1 text-sm text-white">{task.title}</span>
            </div>

            {task.blocked_reason && reasonId !== task.id && (
              <p className="text-[11px] text-muted pl-8">
                <span className="text-muted-dim">Why not: </span>
                {task.blocked_reason}
              </p>
            )}

            {reasonId === task.id ? (
              <input
                autoFocus
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commit(task)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                  if (e.key === 'Escape') setReasonId(null)
                }}
                placeholder="The client review overran…"
                aria-label={`What got in the way of "${task.title}"`}
                className="w-full px-4 py-2.5 bg-background border border-accent rounded-xl text-white text-xs placeholder-hint focus:outline-none min-h-[44px]"
              />
            ) : (
              onSaveReason && (
                <button
                  type="button"
                  onClick={() => {
                    setReasonId(task.id)
                    setDraft(task.blocked_reason || '')
                  }}
                  className="text-[11px] text-muted hover:text-white underline underline-offset-2 pl-8"
                >
                  {task.blocked_reason ? 'Change why' : 'Say what got in the way'}
                </button>
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
