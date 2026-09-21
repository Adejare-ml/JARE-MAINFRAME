import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { formatNaira } from '../lib/formatters'

/**
 * Minimal by design -- the citation-gated dispatch table this calls
 * (src/lib/nlQuery.js) only ever answers with a small typed object, never
 * prose, so there is no summary to render, only the shape it returned.
 */
function AnswerValue({ value }) {
  if (typeof value === 'number') return <>{formatNaira(value)}</>
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Ask 💬</h1>
        <p className="text-muted text-sm mt-1">
          Ask a question about your own money. Answers come from real numbers, never a guess.
        </p>
      </div>

      <form onSubmit={ask} className="bg-card rounded-2xl p-6 border border-white/5 space-y-4">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. How much have I spent on transport this month?"
          rows={3}
          className="w-full bg-background rounded-xl p-4 text-white placeholder:text-muted-dim border border-white/5 focus:outline-none focus:ring-2 focus:ring-accent/50 resize-none"
        />
        <button
          type="submit"
          disabled={asking || !question.trim()}
          className="px-5 py-2.5 bg-accent text-black rounded-xl text-sm font-medium min-h-[48px] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </form>

      {error && (
        <section className="bg-card rounded-2xl p-6 border border-red-500/20">
          <p className="text-sm text-red-400">{error}</p>
        </section>
      )}

      {answer && (
        <section className="bg-card rounded-2xl p-6 border border-white/5">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Answer</h2>
          <dl className="space-y-2">
            {Object.entries(answer).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between">
                <dt className="text-sm text-muted capitalize">{key.replace(/([A-Z])/g, ' $1')}</dt>
                <dd className="text-white font-medium">
                  <AnswerValue value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  )
}
