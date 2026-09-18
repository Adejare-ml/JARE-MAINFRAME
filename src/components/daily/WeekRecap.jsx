import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { hasColumn } from '../../lib/schema'

/**
 * A few sentences about the week that just closed, written by
 * scripts/weekly-recap.mjs and shown exactly as stored -- nothing here
 * re-phrases or re-checks them.
 *
 * That is deliberate, not laziness. Every sentence in `sentences` has already
 * passed src/lib/recapReview.js: it cites a real fact and every number in it
 * matches that fact's own numbers. Re-deriving anything from the sentence
 * text here would be trusting the model's prose over the review that already
 * ran, which is the one thing this whole feature exists to avoid.
 *
 * Always about *last* week, never the one WeekReview's own cards are showing.
 * The script runs Monday morning, after the week it describes has fully
 * closed, so `week_start` here is deliberately the value WeekReview.jsx calls
 * `lastWeekStart` -- passing the in-progress week's start would ask for a row
 * that will not exist until next Monday, and worse, the sentences it wrote
 * say "this week" about a week that, read days later, no longer is one.
 *
 * Self-contained for the same reason CashReconciliation and UpcomingBills are
 * -- its own fetch, one row, so the page's central Promise.all does not grow
 * a query that only this card needs. Renders nothing before migration 023 has
 * run, before a recap has ever been written, or for a week that genuinely had
 * nothing worth saying -- three different kinds of "no card", none of them an
 * error.
 */
export default function WeekRecap({ weekStart }) {
  const [recap, setRecap] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!hasColumn('week_recaps.week_start')) {
      setLoading(false)
      return
    }

    let cancelled = false
    supabase
      .from('week_recaps')
      .select('sentences, drafted_at')
      .eq('week_start', weekStart)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.warn('Could not load the week recap:', error.message)
        setRecap(error ? null : data)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [weekStart])

  if (loading) return null

  const sentences = Array.isArray(recap?.sentences) ? recap.sentences : []
  if (sentences.length === 0) return null

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-2.5">
      <h2 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-1.5">
        <span aria-hidden="true">💭</span> Last week, in a few words
      </h2>
      <ul className="space-y-1.5">
        {sentences.map((s, i) => (
          <li key={i} className="text-sm text-white/80 leading-relaxed">
            {s.sentence}
          </li>
        ))}
      </ul>
    </section>
  )
}
