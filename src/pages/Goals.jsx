import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import Button from '../components/ui/Button'
import Stat from '../components/ui/Stat'
import StatusDot from '../components/ui/StatusDot'
import Icon from '../components/ui/Icon'
import ListRow, { ListRows } from '../components/ui/ListRow'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  toDateOnly,
  daysAgo,
  orderGoalsBySlot,
  startOfMonth,
  startOfWeek,
  excludeVoided,
  excludeDrafts,
  transactionSummaryColumns,
} from '../lib/queries'
import { hasColumn } from '../lib/schema'
import { goalProgress, periodWindow, staleGoals, rolledTargetDate, STALE_GOAL_DAYS } from '../lib/planning'
import ActivityGrid from '../components/daily/ActivityGrid'
import { GoalsSkeleton } from '../components/ui/PageSkeleton'
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
  // Open goals whose period ended more than two weeks ago (src/lib/planning.js).
  const [stale, setStale] = useState([])
  const [staleBusy, setStaleBusy] = useState(null)
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
      const [dailyRes, targetRes, txnRes, walletRes, draftRes, gapRes, staleRes] = await Promise.all([
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
            // Same earliest-date rule as the transactions below: a weekly
            // goal anchored on Monday 29 Sep must still show on Wed 1 Oct.
            .gte('target_date', [startOfMonth(), startOfWeek()].sort()[0])
            .order('period', { ascending: true }),
        ),
        // From the start of the month or of this week, whichever is earlier:
        // in the first days of a month the current week began last month, and
        // a weekly target scored from the 1st missed its first days. Each card
        // narrows these rows to its own period below.
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionSummaryColumns())
            .gte('transaction_date', [startOfMonth(), startOfWeek()].sort()[0]),
        ),
        supabase.from('wallets').select('id, name, type, is_active'),
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
        // Open goals from periods that ended a while ago, to close or roll.
        // The two queries above stop at this month and this week, so these
        // rows are never on screen otherwise. Additive: staleGoals filters
        // the rest (generated rows, drafts) in code.
        excludeDrafts(
          supabase
            .from('goals')
            .select('*')
            .eq('completed', false)
            .is('parent_id', null)
            .lt('target_date', daysAgo(STALE_GOAL_DAYS))
            .order('target_date', { ascending: true })
            .limit(50),
        ),
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
      if (staleRes.error) console.warn('Stale goals unavailable:', staleRes.error.message)
      setStale(staleRes.error ? [] : staleGoals(staleRes.data || [], toDateOnly(new Date())))
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
  /**
   * A stale goal is closed as done-with (completed, so it leaves every list)
   * or rolled into the current period of its cadence, same slot. Rolling can
   * collide with a goal already in that slot this period (009's unique key):
   * that is a 23505, and the owner is told rather than silently overwritten.
   */
  const resolveStale = async (goal, action) => {
    setStaleBusy(goal.id)
    try {
      const row =
        action === 'close'
          ? { completed: true }
          : { target_date: rolledTargetDate(goal, today) }
      const { error } = await supabase.from('goals').update(row).eq('id', goal.id)
      if (error) {
        if (error.code === '23505') {
          toast.error('That slot already has a goal this period. Edit it there, or close this one.')
          return
        }
        throw error
      }
      toast.success(action === 'close' ? 'Closed' : 'Rolled into this period')
      fetchGoals()
    } catch (err) {
      console.error('Error resolving stale goal:', err)
      toast.error('Failed: ' + (err.message || 'check connection'))
    } finally {
      setStaleBusy(null)
    }
  }

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
          toast.error('That period already holds ten goals. Finish or remove one first.')
          return
        }
        row = { ...fields, slot }
      }

      const { error } = id
        ? await supabase.from('goals').update(row).eq('id', id)
        : await supabase.from('goals').insert(row)
      if (error) throw error

      toast.success(id ? 'Updated' : 'Goal set')
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
      toast.success(status === PLAN_STATUS.ACTIVE ? 'Plan approved' : 'Discarded')
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
      toast.success('Logged')
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
      toast.success('Deleted')
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
    return <GoalsSkeleton />
  }

  if (pageError) {
    return (
      <div className="space-y-3 pb-6">
        <PageHeader title="Goals" />
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
  // Spending caps judge liquid wallets only, the way Budget does.
  const liquidWalletIds = wallets.filter((w) => ['bank', 'mobile', 'cash'].includes(w.type)).map((w) => w.id)

  const doneToday = todayGoals.filter(g => {
    const p = goalProgress(g, todayTransactions, { liquidWalletIds })
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

  const openNew = () => {
    setEditing(null)
    setShowForm(true)
  }

  return (
    <div className="space-y-3 pb-6">
      <PageHeader
        title="Goals"
        actions={
          <>
            <Button size="sm" variant="ghost" to="/projects">
              Projects
            </Button>
            {canPlan && (
              <Button size="sm" icon="plus" onClick={openNew}>
                New
              </Button>
            )}
          </>
        }
      />

      {/* Goals from periods long over, still open. Close them or roll them
          into this period; nothing is re-filed on its own. */}
      {stale.length > 0 && (
        <Panel
          label="Past their date"
          meta={`${stale.length} goal${stale.length === 1 ? '' : 's'}`}
          tone="warn"
          flush
        >
          <ListRows as="ul">
            {stale.map(({ goal, endedOn, daysPast }) => {
              const unit = goal.period === 'monthly' ? 'month' : goal.period === 'weekly' ? 'week' : 'day'
              return (
                <ListRow
                  key={goal.id}
                  as="li"
                  title={goal.title}
                  subtitle={`${goal.period.charAt(0).toUpperCase()}${goal.period.slice(1)} · ${daysPast} days ago`}
                  meta={formatDate(endedOn)}
                  trailing={
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => resolveStale(goal, 'roll')}
                        disabled={staleBusy === goal.id}
                        aria-label={`Roll "${goal.title}" into this ${unit}`}
                      >
                        Roll over
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => resolveStale(goal, 'close')}
                        disabled={staleBusy === goal.id}
                        aria-label={`Close "${goal.title}"`}
                      >
                        Close
                      </Button>
                    </>
                  }
                />
              )
            })}
          </ListRows>
        </Panel>
      )}

      {/* First, because it is the only thing here that is waiting on you. */}
      <ProposedPlan
        drafts={drafts}
        onApprove={() => decidePlan(PLAN_STATUS.ACTIVE)}
        onDiscard={() => decidePlan(PLAN_STATUS.DISCARDED)}
        busy={planBusy}
      />

      {/* Monthly and weekly targets */}
      <Panel label="Targets" meta={canPlan && targets.length > 0 ? `${targets.length} set` : null} flush>
        {!canPlan ? (
          <p className="flex items-start gap-2.5 p-3 lg:p-4 text-body-sm text-foreground">
            <StatusDot status="warn" className="mt-1.5" />
            <span>
              Monthly and weekly goals need{' '}
              <code className="type-data text-muted break-all">supabase/migrations/009_goal_cadence.sql</code>. Run it
              in the Supabase SQL editor and this section starts working. Today's priorities below are unaffected.
            </span>
          </p>
        ) : targets.length === 0 ? (
          <EmptyState
            title="No targets set"
            message="Set a target for the month and it will work out what that means each week and each day, and read its own progress from your transactions"
            actionLabel="New target"
            onAction={openNew}
          />
        ) : (
          <ul className="divide-y divide-border">
            {targets.map((goal) => (
              <TargetCard
                key={goal.id}
                goal={goal}
                liquidWalletIds={liquidWalletIds}
                // Only the rows inside the goal's own period. goalProgress sums
                // whatever it is handed, so a weekly target given month-to-date
                // rows showed the whole month's spend from the second week on.
                transactions={monthTransactions.filter((t) => {
                  const w = periodWindow(goal)
                  return !w || (t.transaction_date >= w.from && t.transaction_date <= w.to)
                })}
                today={today}
                onEdit={(g) => {
                  setEditing(g)
                  setShowForm(true)
                }}
                onDelete={handleDelete}
                confirmingDelete={confirmDeleteId === goal.id}
              />
            ))}
          </ul>
        )}
      </Panel>

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

      {/* Stats: real counts, not the zeros that used to be hardcoded here */}
      <Panel label="How it is going">
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Done today"
            value={
              <span className="tabular-nums">
                {doneToday}
                <span className="text-muted font-normal">/{todayGoals.length || 0}</span>
              </span>
            }
          />
          <Stat label={`${HISTORY_DAYS}-day rate`} value={completionRate == null ? 'None yet' : `${completionRate}%`} />
          <Stat label="All done" value={perfectDays} />
        </div>
      </Panel>

      {/* Consistency, at a glance -- and the streak, which used to live only
          on Daily HQ even though this is the page about how you've been
          doing. Scoped to hand-typed priorities: a measured (metric) goal's
          doneness for a day outside this month cannot be checked here, since
          only this month's transactions are loaded -- the same limitation
          `perfectDays` above already works around, by the same means. */}
      <ActivityGrid tasks={tickable} isDone={(g) => g.completed} today={today} />

      {/* History */}
      {history.length > 0 && (
        <Panel label={`Last ${HISTORY_DAYS} days`} flush>
          <ul className="divide-y divide-border">
            {[...byDate.entries()]
              .filter(([date]) => date !== today)
              .map(([date, dayGoals]) => (
                <li key={date} className="px-3 py-2.5 lg:px-4">
                  <div className="flex items-center justify-between gap-3 mb-1">
                    <p className="type-data text-muted">{formatDate(date)}</p>
                    <p className="type-data text-muted-dim">
                      {dayGoals.filter(g => g.completed).length}/{dayGoals.length} done
                    </p>
                  </div>
                  <ul className="space-y-0.5">
                    {dayGoals.map(goal => (
                      <li key={goal.id} className="flex items-center gap-2 text-body-sm">
                        {goal.completed ? (
                          <Icon name="check" size={16} className="text-accent shrink-0" title="Done" />
                        ) : (
                          <span className="inline-flex w-4 justify-center shrink-0">
                            <StatusDot status="never" />
                            <span className="sr-only">Not done</span>
                          </span>
                        )}
                        <span className={`min-w-0 truncate ${goal.completed ? 'text-muted line-through' : 'text-foreground'}`}>
                          {goal.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ul>
        </Panel>
      )}

      {/* Last, because it is a place to put something rather than something to
          read. It is also the input that makes next month's plan about you. */}
      {canReview && (
        <KnowledgeGaps gaps={gaps} onLog={logGap} onResolve={resolveGap} busy={planBusy} />
      )}
    </div>
  )
}
