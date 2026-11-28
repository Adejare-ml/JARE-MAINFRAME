import { useState } from 'react'
import { formatDate } from '../../lib/formatters'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Button from '../ui/Button'
import { Input } from '../ui/Field'

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
    <Panel
      label="Gaps"
      meta={open.length > 0 ? `${open.length} open` : null}
      action={
        !adding && (
          <Button size="sm" variant="secondary" icon="plus" onClick={() => setAdding(true)}>
            Log one
          </Button>
        )
      }
      flush
    >
      <p className="p-3 lg:px-4 text-body-sm text-muted">
        Things you took on trust. The planner works from these before it works from the code.
      </p>

      {adding && (
        <form onSubmit={submit} className="px-3 pb-3 lg:px-4 space-y-3">
          <Input
            autoFocus
            label="What did you not understand?"
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="PostgREST upsert semantics"
            maxLength={120}
          />
          <Input
            label="What happened?"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Took the onConflict line without knowing what it arbitrates"
            maxLength={300}
          />
          <div className="flex gap-2">
            <Button type="submit" className="flex-1" disabled={busy || !topic.trim()}>
              Log it
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAdding(false)
                setTopic('')
                setNote('')
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {open.length === 0 && !adding && (
        <p className="px-3 pb-3 lg:px-4 text-body-sm text-muted-dim">
          Nothing logged. Until there is, the planner has only the code to go on.
        </p>
      )}

      {open.length > 0 && (
        <div className="border-t border-border">
          <ListRows as="ul">
            {open.map((gap) => (
              <ListRow
                key={gap.id}
                as="li"
                wrap
                title={gap.topic}
                subtitle={gap.note}
                meta={`${gap.source === 'agent' ? 'From an agent' : 'Noticed yourself'} · ${formatDate(String(gap.created_at || '').slice(0, 10))}`}
                trailing={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onResolve(gap)}
                    disabled={busy}
                    aria-label={`Mark "${gap.topic}" understood`}
                  >
                    I get it now
                  </Button>
                }
              />
            ))}
          </ListRows>
        </div>
      )}

      {closed.length > 0 && (
        <p className="px-3 py-3 lg:px-4 border-t border-border text-body-sm text-muted-dim">
          {closed.length} closed: {closed.slice(0, 3).map((g) => g.topic).join(', ')}
          {closed.length > 3 && ` and ${closed.length - 3} more`}
        </p>
      )}
    </Panel>
  )
}
