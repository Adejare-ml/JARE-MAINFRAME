import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate, formatNaira } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  toDateOnly,
  daysAgo,
  orderGoalsBySlot,
  startOfMonth,
  excludeVoided,
  transactionSummaryColumns,
} from '../lib/queries'
import { hasColumn } from '../lib/schema'
import GoalForm from '../components/goals/GoalForm'
import TargetCard from '../components/goals/TargetCard'

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
  const [targets, setTargets] = useState([])
  const [monthTransactions, setMonthTransactions] = useState([])
  const [wallets, setWallets] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [togglingId, setTogglingId] = useState(null)

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const today = toDateOnly(new Date())

  // Migration 009 brought the cadence columns. Without it this page still
  // works -- the daily list below is untouched by 009 -- but a goal cannot be
  // created, because the insert would name columns the database does not have
  // and come back PGRST204.
  const canPlan = hasColumn('goals.metric')

  const fetchGoals = useCallback(async () => {
    try {
      setPageError(null)

      // `period` predates 009 and is not gated, so filtering on it is safe on
      // any database. Filtering or ordering on `metric` would not be: that is a
      // 42703 on a database behind the app, which is the outage schema.js
      // exists to prevent.
      const [dailyRes, targetRes, txnRes, walletRes] = await Promise.all([
        orderGoalsBySlot(
          supabase
            .from('goals')
            .select('*')
            .eq('period', 'daily')
            .gte('target_date', daysAgo(HISTORY_DAYS))
            .order('target_date', { ascending: false }),
        ),
        supabase
          .from('goals')
          .select('*')
          .in('period', ['monthly', 'weekly'])
          .gte('target_date', startOfMonth())
          .order('period', { ascending: true }),
        // Scoped to the month: a monthly goal needs the whole month and a
        // weekly one a subset of it, so one fetch serves both.
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionSummaryColumns())
            .gte('transaction_date', startOfMonth()),
        ),
        supabase.from('wallets').select('id, name, is_active'),
      ])

      if (dailyRes.error) throw dailyRes.error
      if (targetRes.error) throw targetRes.error
      if (txnRes.error) throw txnRes.error
      if (walletRes.error) throw walletRes.error

      setGoals(dailyRes.data || [])
      setTargets(targetRes.data || [])
      setMonthTransactions(txnRes.data || [])
      setWallets(walletRes.data || [])
    } catch (err) {
      console.error('Error loading goals:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * Save a goal. Hand-created goals take a slot in the 0-9 range: migration
   * 009 reserves 10+ for generated rows, and a NULL slot is invisible to
   * `on conflict (period, target_date, slot)` -- so it would look saved while
   * every later write inserted another copy beside it.
   */
  const handleSave = async (payload) => {
    setSaving(true)
    try {
      const { id, ...fields } = payload

      let row = fields
      if (!id) {
        const taken = new Set(
          targets
            .filter((t) => t.period === fields.period && t.target_date === fields.target_date)
            .map((t) => t.slot),
        )
        let slot = 0
        while (slot < 10 && taken.has(slot)) slot++
        if (slot >= 10) {
          toast.error('That period already holds ten goals — finish or remove one first')
          return
        }
        row = { ...fields, slot }
      }

      const { error } = id
        ? await supabase.from('goals').update(row).eq('id', id)
        : await supabase.from('goals').insert(row)
      if (error) throw error

      toast.success(id ? 'Updated ✓' : 'Goal set ✓')
      setShowForm(false)
      setEditing(null)
      fetchGoals()
    } catch (err) {
      console.error('Error saving goal:', err)
      toast.error('Failed to save: ' + (err.message || 'check connection'))
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id, confirmed = false) => {
    if (!confirmed) {
      setConfirmDeleteId(id)
      return
    }
    try {
      // 009's parent_id cascade takes the generated children with it, so this
      // cannot leave tasks in tomorrow's list with nothing to explain them.
      const { error } = await supabase.from('goals').delete().eq('id', id)
      if (error) throw error
      toast.success('Deleted ✓')
      setConfirmDeleteId(null)
      fetchGoals()
    } catch (err) {
      console.error('Error deleting goal:', err)
      toast.error('Could not delete: ' + (err.message || 'check connection'))
    }
  }

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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Goals 🎯</h1>
          <p className="text-muted text-sm mt-0.5">
            What you are aiming at, and today's priorities
          </p>
        </div>
        {canPlan && (
          <button
            onClick={() => {
              setEditing(null)
              setShowForm(true)
            }}
            className="px-4 py-2.5 bg-accent text-black rounded-xl text-sm font-bold min-h-[48px] flex-shrink-0"
          >
            + New
          </button>
        )}
      </div>

      {/* Monthly and weekly targets */}
      <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
          Targets
        </h2>

        {!canPlan ? (
          <p className="text-xs text-yellow-400 leading-relaxed">
            Monthly and weekly goals need{' '}
            <code className="font-mono text-yellow-200">
              supabase/migrations/009_goal_cadence.sql
            </code>
            . Run it in the Supabase SQL editor and this section starts working. Today's
            priorities below are unaffected.
          </p>
        ) : targets.length === 0 ? (
          <div className="text-center py-6 space-y-2">
            <span className="text-3xl block" aria-hidden="true">🎯</span>
            <p className="text-sm text-muted max-w-xs mx-auto">
              Set a target for the month and it will work out what that means each week
              and each day — and read its own progress from your transactions.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {targets.map((goal) => (
              <TargetCard
                key={goal.id}
                goal={goal}
                transactions={monthTransactions}
                today={today}
                onEdit={(g) => {
                  setEditing(g)
                  setShowForm(true)
                }}
                onDelete={handleDelete}
                confirmingDelete={confirmDeleteId === goal.id}
              />
            ))}
          </div>
        )}
      </section>

      <GoalForm
        open={showForm}
        editing={editing}
        wallets={wallets}
        saving={saving}
        onClose={() => {
          setShowForm(false)
          setEditing(null)
        }}
        onSave={handleSave}
      />

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
