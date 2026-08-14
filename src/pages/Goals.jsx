import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  toDateOnly,
  daysAgo,
  orderGoalsBySlot,
  startOfMonth,
  excludeVoided,
  excludeDrafts,
  transactionSummaryColumns,
} from '../lib/queries'
import { hasColumn } from '../lib/schema'
import { goalProgress } from '../lib/planning'
import GoalForm from '../components/goals/GoalForm'
import TargetCard from '../components/goals/TargetCard'
import ProposedPlan from '../components/goals/ProposedPlan'
import KnowledgeGaps from '../components/goals/KnowledgeGaps'
import { PLAN_STATUS } from '../lib/planReview'

/**
 * Goals: what you are aiming at, and how the last thirty days went.
 *
 * Today's tasks are NOT here -- they live on Daily HQ, where they are written
 * and now also ticked. This page kept the history deliberately: the activity
 * grid over there answers "how have I been doing" at a glance, and this answers
 * "what did I actually write down on the 5th", which is a different question a
 * grid cannot answer.
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

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [drafts, setDrafts] = useState([])
  const [gaps, setGaps] = useState([])
  const [planBusy, setPlanBusy] = useState(false)

  const today = toDateOnly(new Date())

  // Migration 009 brought the cadence columns. Without it this page still
  // works -- the daily list below is untouched by 009 -- but a goal cannot be
  // created, because the insert would name columns the database does not have
  // and come back PGRST204.
  const canPlan = hasColumn('goals.metric')

  // 011 brought the planner's columns. Without it there are no drafts to review
  // and nowhere to log a gap, so both sections are absent rather than broken --
  // and `excludeDrafts` is a no-op, which is correct: nothing can be a draft.
  const canReview = hasColumn('goals.plan_status')

  const fetchGoals = useCallback(async () => {
    try {
      setPageError(null)

      // `period` predates 009 and is not gated, so filtering on it is safe on
      // any database. Filtering or ordering on `metric` would not be: that is a
      // 42703 on a database behind the app, which is the outage schema.js
      // exists to prevent.
      const [dailyRes, targetRes, txnRes, walletRes, draftRes, gapRes] = await Promise.all([
        orderGoalsBySlot(
          excludeDrafts(
            supabase
              .from('goals')
              .select('*')
              .eq('period', 'daily')
              .gte('target_date', daysAgo(HISTORY_DAYS))
              .order('target_date', { ascending: false }),
          ),
        ),
        // Active only. The drafts the planner proposed are fetched separately
        // below and shown as a proposal to approve -- mixing them in here would
        // present a suggestion as a target you already hold.
        excludeDrafts(
          supabase
            .from('goals')
            .select('*')
            .in('period', ['monthly', 'weekly'])
            .gte('target_date', startOfMonth())
            .order('period', { ascending: true }),
        ),
        // Scoped to the month: a monthly goal needs the whole month and a
        // weekly one a subset of it, so one fetch serves both.
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionSummaryColumns())
            .gte('transaction_date', startOfMonth()),
        ),
        supabase.from('wallets').select('id, name, is_active'),
        // The planner's two halves, both additive. A page that fails because a
        // proposal could not load would make the optional part of this feature
        // able to break the part you rely on.
        canReview
          ? supabase
              .from('goals')
              .select('*')
              .eq('plan_status', PLAN_STATUS.DRAFT)
              .order('target_date', { ascending: true })
          : Promise.resolve({ data: [], error: null }),
        canReview
          ? supabase
              .from('knowledge_gaps')
              .select('*')
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [], error: null }),
      ])

      if (dailyRes.error) throw dailyRes.error
      if (targetRes.error) throw targetRes.error
      if (txnRes.error) throw txnRes.error
      if (walletRes.error) throw walletRes.error

      if (draftRes.error) console.warn('Proposed plan unavailable:', draftRes.error.message)
      if (gapRes.error) console.warn('Knowledge gaps unavailable:', gapRes.error.message)

      setGoals(dailyRes.data || [])
      setTargets(targetRes.data || [])
      setMonthTransactions(txnRes.data || [])
      setWallets(walletRes.data || [])
      setDrafts(draftRes.error ? [] : draftRes.data || [])
      setGaps(gapRes.error ? [] : gapRes.data || [])
    } catch (err) {
      console.error('Error loading goals:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
    // `canReview` is read inside this callback, and it flips from false to true
    // when the startup probe lands. Without it in the deps the first fetch's
    // answer would stick and the proposal would stay invisible until a reload.
  }, [canReview])

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

  /**
   * Accept the proposed plan, or throw it away.
   *
   * Approving flips `plan_status` and nothing else. The words become yours; the
   * numbers were never the model's to give -- how much each week asks for is
   * still worked out from the goal by planning.js, every run.
   *
   * Discarding marks rather than deletes. A proposal you rejected is worth
   * keeping: it is the record of what the planner suggested and what you
   * thought of it, which is the only way to tell later whether it is getting
   * better or worse.
   */
  const decidePlan = async (status) => {
    if (drafts.length === 0) return
    setPlanBusy(true)

    const ids = drafts.map((d) => d.id)
    const previous = drafts
    setDrafts([])

    // Approving the week that is already under way would otherwise leave two
    // rows for it: the one the generator wrote from arithmetic, and the one the
    // planner wrote from evidence. They share a parent and a week, so from then
    // on which of them the generator maintained would depend on row order.
    // The planned row is the one to keep -- it carries the words -- so the
    // generator's is removed and it rebuilds the number onto the survivor.
    if (status === PLAN_STATUS.ACTIVE) {
      for (const draft of previous) {
        if (!draft.parent_id) continue
        await supabase
          .from('goals')
          .delete()
          .eq('parent_id', draft.parent_id)
          .eq('period', draft.period)
          .eq('target_date', draft.target_date)
          .eq('generated', true)
      }
    }

    const { error } = await supabase.from('goals').update({ plan_status: status }).in('id', ids)

    if (error) {
      setDrafts(previous)
      toast.error('Could not save that: ' + error.message)
    } else {
      toast.success(status === PLAN_STATUS.ACTIVE ? 'Plan approved ✓' : 'Discarded')
      fetchGoals()
    }
    setPlanBusy(false)
  }

  /**
   * Log something you took on trust.
   *
   * Upserted on `topic`, which migration 011 makes unique: hitting the same
   * wall twice should deepen one record rather than scatter five near-identical
   * ones the planner would then read as five separate gaps. Re-logging a closed
   * gap reopens it, which is the honest thing to do when it comes back.
   */
  const logGap = async ({ topic, note }) => {
    setPlanBusy(true)
    const { error } = await supabase
      .from('knowledge_gaps')
      .upsert({ topic, note, source: 'agent', resolved_at: null, updated_at: new Date().toISOString() },
        { onConflict: 'topic' })

    if (error) toast.error('Could not log that: ' + error.message)
    else {
      toast.success('Logged ✓')
      fetchGoals()
    }
    setPlanBusy(false)
  }

  /** Closed, not deleted -- a gap you closed is the most useful row in the table. */
  const resolveGap = async (gap) => {
    setPlanBusy(true)
    const { error } = await supabase
      .from('knowledge_gaps')
      .update({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', gap.id)

    if (error) toast.error('Could not save that: ' + error.message)
    else fetchGoals()
    setPlanBusy(false)
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
  const todayTransactions = monthTransactions.filter(t => t.transaction_date === today)
  const history = goals.filter(g => g.target_date !== today)

  // Today's count can be exact, because today's transactions are loaded: a
  // measured task is done when the ledger says so, a typed one when it is
  // ticked.
  const doneToday = todayGoals.filter(g => {
    const p = goalProgress(g, todayTransactions)
    return p.measured ? p.met : g.completed
  }).length

  // The 30-day figures cannot be. Doneness for a measured task lives in the
  // transactions of the day it belongs to, and only this month's are loaded --
  // so counting those rows would report every one of them as missed. They are
  // excluded instead, and the tiles measure what they can actually see: the
  // tasks whose completion is a stored decision.
  const tickable = goals.filter(g => !g.metric || g.metric === 'manual')
  const completedCount = tickable.filter(g => g.completed).length
  const completionRate = tickable.length > 0
    ? Math.round((completedCount / tickable.length) * 100)
    : null

  // Days where every priority set was ticked off.
  const byDate = new Map()
  for (const g of goals) {
    if (!byDate.has(g.target_date)) byDate.set(g.target_date, [])
    byDate.get(g.target_date).push(g)
  }
  const perfectDays = [...byDate.values()].filter(
    day => day.some(g => !g.metric || g.metric === 'manual')
      && day.every(g => (!g.metric || g.metric === 'manual') ? g.completed : true),
  ).length

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

      {/* First, because it is the only thing here that is waiting on you. */}
      <ProposedPlan
        drafts={drafts}
        onApprove={() => decidePlan(PLAN_STATUS.ACTIVE)}
        onDiscard={() => decidePlan(PLAN_STATUS.DISCARDED)}
        busy={planBusy}
      />

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
            {doneToday}
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

      {/* Last, because it is a place to put something rather than something to
          read. It is also the input that makes next month's plan about you. */}
      {canReview && (
        <KnowledgeGaps gaps={gaps} onLog={logGap} onResolve={resolveGap} busy={planBusy} />
      )}
    </div>
  )
}
