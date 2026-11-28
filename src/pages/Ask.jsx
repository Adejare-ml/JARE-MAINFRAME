import { useState } from 'react'
import { supabase } from '../lib/supabase'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Money from '../components/ui/Money'
import Button from '../components/ui/Button'
import StatusDot from '../components/ui/StatusDot'
import { Textarea } from '../components/ui/Field'

/**
 * Minimal by design -- the citation-gated dispatch table this calls
 * (src/lib/nlQuery.js) only ever answers with a small typed object, never
 * prose, so there is no summary to render, only the shape it returned.
 */
function AnswerValue({ value }) {
  if (typeof value === 'number') return <Money amount={value} />
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>
  if (value == null) return <>—</>
  return <>{String(value)}</>
}

export default function Ask() {
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState(null)
  const [error, setError] = useState(null)

  const ask = async (e) => {
    e.preventDefault()
    const trimmed = question.trim()
    if (!trimmed || asking) return

    setAsking(true)
    setError(null)
    setAnswer(null)

    try {
      const { data, error: invokeError } = await supabase.functions.invoke('ask-question', {
        body: { question: trimmed },
      })
      if (invokeError) throw invokeError
      if (!data?.ok) {
        setError(data?.reason || 'Could not answer that.')
      } else {
        setAnswer(data.result)
      }
    } catch (err) {
      setError(err.message || 'Something went wrong asking that.')
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="space-y-3 pb-6">
      <PageHeader title="Ask" meta="Answers from real numbers" />

      <Panel label="Question">
        <form onSubmit={ask} className="space-y-3">
          <p className="text-body-sm text-muted">
            Ask a question about your own money. Answers come from real numbers, never a guess.
          </p>
          <Textarea
            aria-label="Question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. How much have I spent on transport this month?"
            rows={3}
          />
          <Button type="submit" icon="ask" loading={asking} disabled={!question.trim()}>
            {asking ? 'Asking…' : 'Ask'}
          </Button>
        </form>
      </Panel>

      {error && (
        <Panel label="No answer" tone="danger">
          <p role="alert" className="flex items-start gap-2 text-body-sm text-foreground">
            <StatusDot status="danger" className="mt-1.5" />
            <span>{error}</span>
          </p>
        </Panel>
      )}

      {answer && (
        <Panel label="Answer" flush>
          <ListRows label="Answer">
            {Object.entries(answer).map(([key, value]) => (
              <ListRow
                key={key}
                title={<span className="capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>}
                trailing={
                  <span className="text-foreground font-medium">
                    <AnswerValue value={value} />
                  </span>
                }
              />
            ))}
          </ListRows>
        </Panel>
      )}
    </div>
  )
}
