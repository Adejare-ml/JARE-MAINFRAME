import { useState } from 'react'
import Panel from '../ui/Panel'
import Button from '../ui/Button'
import TaskCheck from './TaskCheck'
import { controlClasses } from '../ui/Field'

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
    <Panel label="Before you close" meta={`${open.length} open`} flush>
      <p className="px-3 py-2.5 text-body-sm text-muted border-b border-border">
        Tick what landed; say what got in the way of the rest.
      </p>
      <ul className="divide-y divide-border">
        {open.map((task) => (
          <li key={task.id} className="px-3">
            <div className="flex items-center gap-2 min-h-12">
              <TaskCheck
                done={false}
                onClick={() => onToggle(task)}
                disabled={busyId === task.id}
                label={`Mark "${task.title}" done`}
              />
              <span className="min-w-0 flex-1 text-body text-foreground truncate">{task.title}</span>
            </div>

            {task.blocked_reason && reasonId !== task.id && (
              <p className="text-body-sm text-muted pl-9 pb-2">
                <span className="text-muted-dim">Why not: </span>
                {task.blocked_reason}
              </p>
            )}

            {reasonId === task.id ? (
              <div className="pb-2">
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
                  placeholder="The client review overran"
                  aria-label={`What got in the way of "${task.title}"`}
                  className={controlClasses()}
                />
              </div>
            ) : (
              onSaveReason && (
                <div className="pl-6 pb-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setReasonId(task.id)
                      setDraft(task.blocked_reason || '')
                    }}
                    aria-label={task.blocked_reason ? `Change reason for not completing "${task.title}"` : `Add reason for not completing "${task.title}"`}
                  >
                    {task.blocked_reason ? 'Change why' : 'Say what got in the way'}
                  </Button>
                </div>
              )
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
