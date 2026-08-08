import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { toDateOnly, daysAgo } from '../lib/queries'

/**
 * Your daily priorities, read back.
 *
 * Daily HQ has been writing the `goals` table every morning; this page was 62
 * lines of static markup with hardcoded zeros that said "No goals yet" while
 * the rows sat in Postgres.
 */

/** How far back the completion rate looks. */
const HISTORY_DAYS = 30

export default function Goals() {
  const [goals, setGoals] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [togglingId, setTogglingId] = useState(null)

  const today = toDateOnly(new Date())

  const fetchGoals = useCallback(async () => {
    try {
      setPageError(null)
      const { data, error } = await supabase
        .from('goals')
        .select('*')
        .eq('period', 'daily')
        .gte('target_date', daysAgo(HISTORY_DAYS))
        .order('target_date', { ascending: false })
        .order('slot', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })

      if (error) throw error
      setGoals(data || [])
    } catch (err) {
      console.error('Error loading goals:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchGoals()
  }, [fetchGoals])

  useRealtimeRefresh(['goals'], fetchGoals, { channelPrefix: 'goals' })

  const toggleComplete = async (goal) => {
    setTogglingId(goal.id)
    // Optimistic: a checkbox that waits for a round trip on mobile data feels
    // broken. Rolled back below if the write fails.
    const next = !goal.completed
    setGoals(prev => prev.map(g => (g.id === goal.id ? { ...g, completed: next } : g)))

    const { error } = await supabase
      .from('goals')
      .update({ completed: next })
      .eq('id', goal.id)

    if (error) {
      setGoals(prev => prev.map(g => (g.id === goal.id ? { ...g, completed: !next } : g)))
      toast.error('Could not update: ' + error.message)
    }
    setTogglingId(null)
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 bg-white/5 rounded-xl w-48" />
        <div className="h-24 bg-card rounded-3xl border border-white/5" />
        <div className="h-44 bg-card rounded-3xl border border-white/5" />
      </div>
    )
  }

  if (pageError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Goals 🎯</h1>
        <ErrorState message={pageError} onRetry={fetchGoals} />
      </div>
    )
  }

  const todayGoals = goals.filter(g => g.target_date === today)
  const history = goals.filter(g => g.target_date !== today)

  const completedCount = goals.filter(g => g.completed).length
  const completionRate = goals.length > 0 ? Math.round((completedCount / goals.length) * 100) : null

  // Days where every priority set was ticked off.
  const byDate = new Map()
  for (const g of goals) {
    if (!byDate.has(g.target_date)) byDate.set(g.target_date, [])
    byDate.get(g.target_date).push(g)
  }
  const perfectDays = [...byDate.values()].filter(day => day.every(g => g.completed)).length

  return (
    <div className="space-y-6 pb-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold text-white">Goals 🎯</h1>
        <p className="text-muted text-sm mt-0.5">
          Your daily priorities, set each morning on Daily HQ
        </p>
      </div>

      {/* Stats — real counts, not the zeros that used to be hardcoded here */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Done today</p>
          <p className="text-xl font-bold text-white tabular-nums">
            {todayGoals.filter(g => g.completed).length}
            <span className="text-muted text-sm font-normal">/{todayGoals.length || 0}</span>
          </p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">{HISTORY_DAYS}-day rate</p>
          <p className="text-xl font-bold text-accent tabular-nums">
            {completionRate == null ? '—' : `${completionRate}%`}
          </p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Clean sweeps</p>
          <p className="text-xl font-bold text-white tabular-nums">{perfectDays}</p>
        </div>
      </div>

      {/* Today */}
      <section className="bg-card rounded-3xl p-6 border border-white/5">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-4">Today</h2>

        {todayGoals.length === 0 ? (
          <div className="text-center py-6 space-y-3">
            <p className="text-sm text-muted">No priorities set for today yet.</p>
            <Link
              to="/"
              className="inline-block px-5 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] leading-6"
            >
              Set them on Daily HQ →
            </Link>
          </div>
        ) : (
          <ul className="space-y-2">
            {todayGoals.map(goal => (
              <li key={goal.id}>
                <button
                  onClick={() => toggleComplete(goal)}
                  disabled={togglingId === goal.id}
                  aria-pressed={goal.completed}
                  className="w-full flex items-center gap-3 p-3 rounded-2xl bg-background/50 border border-white/5 hover:border-white/10 transition-all min-h-[48px] text-left disabled:opacity-60"
                >
                  <span
                    className={`w-6 h-6 rounded-lg border-2 flex-shrink-0 flex items-center justify-center text-xs font-bold transition-colors ${
                      goal.completed
                        ? 'bg-accent border-accent text-black'
                        : 'border-white/20 text-transparent'
                    }`}
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                  <span className={`text-sm ${goal.completed ? 'text-muted line-through' : 'text-white'}`}>
                    {goal.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* History */}
      {history.length > 0 && (
        <section className="bg-card rounded-3xl p-6 border border-white/5">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-4">
            Last {HISTORY_DAYS} days
          </h2>
          <div className="space-y-4">
            {[...byDate.entries()]
              .filter(([date]) => date !== today)
              .map(([date, dayGoals]) => (
                <div key={date}>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-xs text-muted">{formatDate(date)}</p>
                    <p className="text-[10px] text-muted tabular-nums">
                      {dayGoals.filter(g => g.completed).length}/{dayGoals.length}
                    </p>
                  </div>
                  <ul className="space-y-1">
                    {dayGoals.map(goal => (
                      <li
                        key={goal.id}
                        className={`text-sm flex items-start gap-2 ${
                          goal.completed ? 'text-muted' : 'text-white/70'
                        }`}
                      >
                        <span aria-hidden="true">{goal.completed ? '✅' : '⬜'}</span>
                        <span className={goal.completed ? 'line-through' : ''}>{goal.title}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}
