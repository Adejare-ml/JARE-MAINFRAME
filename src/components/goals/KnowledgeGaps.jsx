import { useState } from 'react'
import { formatDate } from '../../lib/formatters'

/**
 * Things you leaned on an agent for and could not have written yourself.
 *
 * The planner's other grounded input, and the more valuable of the two. The
 * repository can only say what exists; this says what you do not yet know,
 * which is the only thing that makes a month's plan about *you* rather than
 * about any developer with a similar repo.
 *
 * Deliberately two fields and a button. Anything heavier and it does not get
 * used at the moment it matters -- which is right after you pasted in code that
 * worked and you are not sure why, when the last thing you want is a form.
 *
 * Closing one is kept rather than deleted. A gap you closed is the most useful
 * row in this table, and deleting it loses the only record that you did.
 */
export default function KnowledgeGaps({ gaps, onLog, onResolve, busy }) {
  const [adding, setAdding] = useState(false)
  const [topic, setTopic] = useState('')
  const [note, setNote] = useState('')

  const open = (gaps || []).filter((g) => !g.resolved_at)
  const closed = (gaps || []).filter((g) => g.resolved_at)

  const submit = (e) => {
    e.preventDefault()
    const trimmed = topic.trim()
    if (!trimmed) return
    onLog({ topic: trimmed, note: note.trim() || null })
    setTopic('')
    setNote('')
    setAdding(false)
  }

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Gaps</h2>
          <p className="text-xs text-muted mt-1">
            Things you took on trust. The planner works from these before it works from
            the code.
          </p>
        </div>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-muted hover:text-white min-h-[44px] flex-shrink-0"
          >
            Log one
          </button>
        )}
      </div>

      {adding && (
        <form onSubmit={submit} className="space-y-2">
          <input
            autoFocus
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="PostgREST upsert semantics"
            aria-label="What did you not understand?"
            maxLength={120}
            className="w-full px-4 py-3 bg-background border border-accent rounded-xl text-white text-sm placeholder-hint focus:outline-none min-h-[48px]"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Took the onConflict line without knowing what it arbitrates"
            aria-label="What happened?"
            maxLength={300}
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || !topic.trim()}
              className="flex-1 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
            >
              Log it
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false)
                setTopic('')
                setNote('')
              }}
              className="px-5 py-3 bg-white/5 text-muted text-sm font-bold rounded-xl min-h-[48px]"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {open.length === 0 && !adding && (
        <p className="text-xs text-muted py-2">
          Nothing logged. Until there is, the planner has only the code to go on.
        </p>
      )}

      <ul className="space-y-2">
        {open.map((gap) => (
          <li
            key={gap.id}
            className="flex items-start gap-3 bg-background/50 border border-white/5 rounded-2xl p-4"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-white">{gap.topic}</span>
              {gap.note && <span className="block text-[11px] text-muted mt-0.5">{gap.note}</span>}
              <span className="block text-[10px] text-muted-dim mt-0.5">
                {gap.source === 'agent' ? 'From an agent' : 'Noticed yourself'} ·{' '}
                {formatDate(String(gap.created_at || '').slice(0, 10))}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onResolve(gap)}
              disabled={busy}
              aria-label={`Mark "${gap.topic}" understood`}
              className="px-3 py-2 text-[11px] font-bold text-muted hover:text-accent rounded-lg min-h-[44px] flex-shrink-0 disabled:opacity-50"
            >
              I get it now
            </button>
          </li>
        ))}
      </ul>

      {closed.length > 0 && (
        <p className="text-[11px] text-muted-dim pt-1">
          {closed.length} closed — {closed.slice(0, 3).map((g) => g.topic).join(', ')}
          {closed.length > 3 && ` and ${closed.length - 3} more`}
        </p>
      )}
    </section>
  )
}
