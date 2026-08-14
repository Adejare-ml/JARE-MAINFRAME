import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatNaira, formatDate } from '../lib/formatters'
import { getCategoryIcon } from '../lib/constants'
import { toast } from '../lib/toast'
import CashReconciliation from '../components/CashReconciliation'
import ErrorState from '../components/ui/ErrorState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { summarizeMonth } from '../lib/summary'
import { upcomingDebts } from '../lib/debts'
import { generateTasks } from '../lib/generateTasks'
import { isTaskDone, GENERATED_SLOT_BASE } from '../lib/planning'
import { hasColumn } from '../lib/schema'
import TodayList from '../components/daily/TodayList'
import Yesterday from '../components/daily/Yesterday'
import ActivityGrid from '../components/daily/ActivityGrid'
import WeekReview from '../components/daily/WeekReview'
import {
  transactionListColumns,
  orderGoalsBySlot,
  transactionSummaryColumns,
  startOfMonth,
  toDateOnly,
  daysAgo,
  startOfWeek,
  endOfWeek,
  weeksAgo,
  NEEDS_REVIEW_FILTER,
  excludeVoided,
} from '../lib/queries'

/** Days of history the activity grid needs: eight whole weeks plus slack for
 *  whichever weekday today is. */
const GRID_DAYS = 63

export default function DailyHQ() {
  const [wallets, setWallets] = useState([])
  const [transactions, setTransactions] = useState([])
  const [recentRows, setRecentRows] = useState([])
  const [debts, setDebts] = useState([])
  // Every daily row in the grid window. Today's list, yesterday's count and the
  // activity grid are all derived from this one array.
  const [dailyTasks, setDailyTasks] = useState([])
  const [togglingId, setTogglingId] = useState(null)
  const [mode, setMode] = useState('day')
  const [unreviewedCount, setUnreviewedCount] = useState(0)
  const [warnThreshold, setWarnThreshold] = useState(10000)
  // Default until the user sets one in Settings; the bar hides at 0.
  const [budgetTarget, setBudgetTarget] = useState(85000)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)

  // Local date: the UTC form flips at 1am Lagos, which made this page load and
  // save *yesterday's* priorities during that hour.
  const todayDate = toDateOnly(new Date())
  const yesterdayDate = daysAgo(1)
  const weekStart = startOfWeek()
  const weekEnd = endOfWeek()
  const lastWeekStart = weeksAgo(1)

  // One fetch serves the month card, yesterday, and both weeks of the review.
  // Reaching back to the earliest of them means the Day/Week toggle is pure
  // derivation -- no second query, no spinner between modes.
  const earliestNeeded = [startOfMonth(), yesterdayDate, lastWeekStart].sort()[0]
  const fullDateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })

  const currentHour = new Date().getHours()
  const greeting = currentHour < 12 ? 'Good morning' : currentHour < 17 ? 'Good afternoon' : 'Good evening'

  const fetchDailyData = useCallback(async () => {
    try {
      setPageError(null)

      // One round trip's latency instead of six. Five sequential awaits before
      // first paint was five chances to stall on mobile data. And every error
      // is checked: supabase-js returns errors rather than throwing, so the
      // old destructure-data-only version made the catch unreachable and a
      // total network failure rendered "Total: ₦0.00" and "All clear!".
      const [walletsRes, recentRes, countRes, settingsRes, monthRes, goalsRes, debtsRes] =
        await Promise.all([
          supabase.from('wallets').select('*'),
          excludeVoided(
            supabase
              .from('transactions')
              .select(transactionListColumns())
              .order('transaction_date', { ascending: false })
              .order('created_at', { ascending: false })
              .limit(3),
          ),
          excludeVoided(
            supabase
              .from('transactions')
              .select('id', { count: 'exact', head: true })
              .eq(NEEDS_REVIEW_FILTER.column, NEEDS_REVIEW_FILTER.value),
          ),
          supabase
            .from('user_settings')
            .select('key, value')
            .in('key', ['low_balance_threshold', 'monthly_budget_target']),
          // Widened to cover yesterday as well as the month. On the 1st those
          // are different months, so the rows are split apart below rather than
          // summed together -- folding last month's spending into this month's
          // total is exactly the kind of quietly-wrong number this app keeps
          // having to fix.
          excludeVoided(
            supabase
              .from('transactions')
              .select(transactionSummaryColumns())
              .gte('transaction_date', earliestNeeded),
          ),
          // Eight weeks, not just today: the same rows feed today's list,
          // yesterday's count and the activity grid, so one query serves all
          // three rather than three queries serving one each.
          orderGoalsBySlot(
            supabase
              .from('goals')
              .select('*')
              .in('period', ['daily', 'weekly'])
              .gte('target_date', daysAgo(GRID_DAYS)),
          ),
          supabase.from('debts').select('*').eq('settled', false),
        ])

      const firstError =
        walletsRes.error || recentRes.error || countRes.error ||
        settingsRes.error || monthRes.error || goalsRes.error
      if (firstError) throw firstError

      // Debts are additive to this page, not load-bearing: if migration 004
      // has not run yet the table is missing, and the rest of Daily HQ should
      // still render rather than showing an error for a feature you may not
      // use.
      if (debtsRes.error) console.warn('Debts unavailable:', debtsRes.error.message)
      setDebts(debtsRes.error ? [] : debtsRes.data || [])

      setWallets(walletsRes.data || [])
      setTransactions(recentRes.data || [])
      setUnreviewedCount(countRes.count || 0)
      setRecentRows(monthRes.data || [])
      setDailyTasks(goalsRes.data || [])

      for (const row of settingsRes.data || []) {
        const parsed = parseFloat(row.value)
        if (isNaN(parsed) || parsed < 0) continue
        if (row.key === 'low_balance_threshold') setWarnThreshold(parsed)
        if (row.key === 'monthly_budget_target') setBudgetTarget(parsed)
      }

    } catch (err) {
      console.error('Error fetching Daily HQ data:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [todayDate])

  useEffect(() => {
    fetchDailyData()
  }, [fetchDailyData])

  // Derive today's tasks from the goals that imply them.
  //
  // This is the one write in the app that happens without the user asking for
  // it, which is the point -- these are the tasks you did not have to type --
  // but it is kept on a short leash:
  //
  // Its own effect, keyed on the date, and deliberately NOT chained to
  // `fetchDailyData`. That callback is re-fired by the realtime subscription on
  // every burst of transactions, so hanging generation off it would regenerate
  // forty times while a Gmail sync lands.
  //
  // The ref guard is for StrictMode, which double-invokes effects in
  // development; generation is idempotent so a second run is harmless, but it
  // is a wasted round trip.
  const generatedFor = useRef(null)
  useEffect(() => {
    if (generatedFor.current === todayDate) return
    generatedFor.current = todayDate

    let cancelled = false
    generateTasks(supabase, { today: todayDate }).then((result) => {
      // Only refetch if something actually landed. An unchanged day writes
      // nothing, and refetching to display identical rows is the churn this
      // whole reconcile exists to avoid.
      if (!cancelled && result.written > 0) fetchDailyData()
    })
    return () => {
      cancelled = true
    }
  }, [todayDate, fetchDailyData])

  // This page runs five queries per refresh, so an undebounced subscription
  // meant a sync inserting 40 rows fired 200 round trips to render the same
  // three transactions.
  //
  // `goals` is watched too: priorities are ticked here and generated tasks are
  // written by the effect above, so without it a change made on another device
  // -- or by the generator itself -- would sit invisible until a navigation.
  // The 'hq' prefix keeps the topic `hq:goals`, distinct from the Goals page's
  // `goals:goals`, since two channels sharing a topic collide.
  useRealtimeRefresh(['wallets', 'transactions', 'goals'], fetchDailyData, { channelPrefix: 'hq' })

  /**
   * Tick a task. Optimistic, because a checkbox that waits for a round trip on
   * mobile data feels broken; rolled back below if the write fails.
   */
  const toggleTask = async (task) => {
    setTogglingId(task.id)
    const next = !task.completed
    setDailyTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, completed: next } : t)))

    const { error } = await supabase.from('goals').update({ completed: next }).eq('id', task.id)

    if (error) {
      setDailyTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, completed: !next } : t)))
      toast.error('Could not update: ' + error.message)
    }
    setTogglingId(null)
  }

  /**
   * Write a task's title -- an edit when `task` is given, a new one when it is
   * null.
   *
   * `completed` is absent from the payload on purpose, and has been since the
   * upsert replaced a delete-then-insert: editing the words of a task must not
   * untick a box you already ticked.
   */
  const saveTaskTitle = async (task, title) => {
    try {
      if (task) {
        const { error } = await supabase.from('goals').update({ title }).eq('id', task.id)
        if (error) throw error
      } else {
        // Lowest free slot below the generated range. 009 reserves 10+ for
        // derived rows, so a hand-typed task can never land on one.
        //
        // Filtered from `dailyTasks` (state) rather than the derived
        // `todayTasks`, which is declared below the early returns -- closing
        // over it would put this handler one refactor away from a temporal
        // dead zone ReferenceError.
        const taken = new Set(
          dailyTasks
            .filter((t) => t.period === 'daily' && t.target_date === todayDate && t.slot != null)
            .map((t) => t.slot),
        )
        let slot = 0
        while (slot < GENERATED_SLOT_BASE && taken.has(slot)) slot++
        if (slot >= GENERATED_SLOT_BASE) {
          toast.error('That is ten priorities for one day — finish one first')
          return
        }

        const { error } = await supabase.from('goals').upsert(
          { title, slot, period: 'daily', target_date: todayDate },
          { onConflict: 'period,target_date,slot' },
        )
        if (error) throw error
      }
      fetchDailyData()
    } catch (err) {
      console.error('Error saving priority:', err)
      toast.error('Failed to save: ' + (err.message || 'check connection'))
    }
  }

  /**
   * Record why a repo task did not land.
   *
   * The point of the column, and the reason it is a sentence rather than a
   * flag: a bare miss teaches nothing, and "office work overran" read back at
   * the end of a month is the only part of this worth having. It is written
   * separately from `completed` because the two are different admissions -- a
   * task can be explained without being ticked, and ticked without explanation.
   */
  const saveTaskReason = async (task, reason) => {
    if (!hasColumn('goals.blocked_reason')) {
      toast.error('Run 010_repo_goals.sql first — there is nowhere to keep this yet')
      return
    }

    setDailyTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, blocked_reason: reason } : t)),
    )

    const { error } = await supabase
      .from('goals')
      .update({ blocked_reason: reason })
      .eq('id', task.id)

    if (error) {
      setDailyTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, blocked_reason: task.blocked_reason } : t)),
      )
      toast.error('Could not save that: ' + error.message)
    }
  }

  /** Clearing a task's text removes it, the gesture the old three-box form used. */
  const deleteTask = async (task) => {
    const { error } = await supabase.from('goals').delete().eq('id', task.id)
    if (error) {
      toast.error('Could not remove: ' + error.message)
      return
    }
    fetchDailyData()
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 bg-white/5 rounded-xl w-64" />
        <div className="h-32 bg-card rounded-3xl border border-white/5" />
        <div className="h-28 bg-card rounded-3xl border border-white/5" />
        <div className="h-44 bg-card rounded-3xl border border-white/5" />
      </div>
    )
  }

  if (pageError) {
    return (
      <div className="space-y-6 pb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold text-white">{greeting}, Adejare 👋</h1>
        <ErrorState message={pageError} onRetry={fetchDailyData} />
      </div>
    )
  }

  // ── Dynamic Wallet Calculations ──
  const activeWallets = wallets.filter(w => w.is_active !== false)
  const liquidWallets = activeWallets.filter(w => ['bank', 'mobile', 'cash'].includes(w.type))
  const savingsWallets = activeWallets.filter(w => w.type === 'savings')
  const investmentWallets = activeWallets.filter(w => w.type === 'investment')

  const liquidBalance = liquidWallets.reduce((sum, w) => sum + Number(w.balance || 0), 0)
  const savingsBalance = savingsWallets.reduce((sum, w) => sum + Number(w.balance || 0), 0)
  const investmentBalance = investmentWallets.reduce((sum, w) => sum + Number(w.balance || 0), 0)
  const totalBalance = liquidBalance + savingsBalance + investmentBalance

  const hasSavingsOrInvestments = savingsWallets.length > 0 || investmentWallets.length > 0

  // Check Low Balance Alerts against dynamic threshold (liquid wallets only)
  const lowWallets = liquidWallets.filter(w => Number(w.balance || 0) < warnThreshold)

  const dueDebts = upcomingDebts(debts, 7)

  // Monthly Spending Progress. The old version summed the 3-row "recent"
  // query -- the headline card was three transactions divided by a hardcoded
  // 85000. Now: the real month query through the same tested math Budget uses,
  // transfers excluded, against a target set in Settings.
  // One fetch, three windows. Splitting rather than summing keeps the month
  // card exact on the 1st, when `earliestNeeded` reaches into last month.
  const monthTransactions = recentRows.filter((t) => t.transaction_date >= startOfMonth())
  const yesterdayTransactions = recentRows.filter((t) => t.transaction_date === yesterdayDate)
  const todayTransactions = recentRows.filter((t) => t.transaction_date === todayDate)

  // The goals query returns both cadences; split them once here rather than
  // filtering by period at four call sites.
  const dayRows = dailyTasks.filter((t) => t.period === 'daily')
  const weeklyGoals = dailyTasks.filter((t) => t.period === 'weekly' && t.target_date === weekStart)
  const lastWeekGoals = dailyTasks.filter(
    (t) => t.period === 'weekly' && t.target_date === lastWeekStart,
  )

  const todayTasks = dayRows.filter((t) => t.target_date === todayDate)
  const yesterdayTasks = dayRows.filter((t) => t.target_date === yesterdayDate)

  const thisWeekTransactions = recentRows.filter(
    (t) => t.transaction_date >= weekStart && t.transaction_date <= weekEnd,
  )
  const lastWeekTransactions = recentRows.filter(
    (t) => t.transaction_date >= lastWeekStart && t.transaction_date < weekStart,
  )

  // The grid and yesterday's count must judge a measured task by the ledger of
  // ITS OWN day, not today's -- otherwise a task met last Tuesday reads as
  // missed. Rows outside the transaction window have no evidence either way, so
  // they fall back to the stored flag.
  const doneOn = (task) =>
    isTaskDone(task, recentRows.filter((t) => t.transaction_date === task.target_date))

  const liquidWalletIds = new Set(liquidWallets.map(w => w.id))
  const monthSummary = summarizeMonth(monthTransactions, liquidWalletIds)
  const totalSpent = monthSummary.spent
  const percentSpent = budgetTarget > 0
    ? Math.min(Math.round((totalSpent / budgetTarget) * 100), 100)
    : null

  // Type icons for dynamic rendering
  const typeIcons = { bank: '🏦', mobile: '📱', cash: '💵', savings: '🐖', investment: '📈' }

  return (
    <div className="space-y-6 pb-6">
      
      {/* Header */}
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold text-muted tracking-wider uppercase mb-1">
            {mode === 'day' ? fullDateStr : `Week of ${formatDate(weekStart)}`}
          </p>
          <h1 className="text-2xl md:text-3xl font-extrabold text-white">
            {mode === 'day' ? `${greeting}, Adejare 👋` : 'How the week went'}
          </h1>
        </div>

        {/* Day / Week. A view switch, not navigation -- it changes what this
            page is about, not which page you are on. Both modes read the same
            already-fetched rows, so switching is instant. */}
        <div
          role="tablist"
          aria-label="Time range"
          className="inline-flex bg-background border border-white/10 rounded-xl p-1 gap-1"
        >
          {[
            { id: 'day', label: 'Day' },
            { id: 'week', label: 'Week' },
          ].map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={mode === tab.id}
              onClick={() => setMode(tab.id)}
              className={`px-5 py-2 rounded-lg text-xs font-bold transition-colors min-h-[44px] ${
                mode === tab.id ? 'bg-accent text-black' : 'text-muted hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'day' ? (
        <>
        {/* CASH RECONCILIATION PROMPT */}
        <CashReconciliation onReconciled={fetchDailyData} />

        {/* WALLET SNAPSHOT — Dynamic */}
        <section className="bg-card rounded-3xl p-6 border border-white/10 relative overflow-hidden shadow-xl">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">
            Wallet Snapshot
          </p>
          <p className="text-3xl sm:text-4xl font-extrabold text-white mb-4">
            Total: {formatNaira(totalBalance)}
          </p>

          {/* Layered summary if savings/investment exist */}
          {hasSavingsOrInvestments && (
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="bg-background/40 p-2 rounded-xl border border-white/5 text-center">
                <p className="text-[10px] text-muted">💳 Liquid</p>
                <p className="text-xs font-bold text-white">{formatNaira(liquidBalance)}</p>
              </div>
              <div className="bg-background/40 p-2 rounded-xl border border-white/5 text-center">
                <p className="text-[10px] text-muted">🐖 Savings</p>
                <p className="text-xs font-bold text-blue-400">{formatNaira(savingsBalance)}</p>
              </div>
              <div className="bg-background/40 p-2 rounded-xl border border-white/5 text-center">
                <p className="text-[10px] text-muted">📈 Invested</p>
                <p className="text-xs font-bold text-purple-400">{formatNaira(investmentBalance)}</p>
              </div>
            </div>
          )}

          {/* Individual wallet tiles — dynamic */}
          <div className={`grid gap-2 pt-3 border-t border-white/5 text-center sm:text-left ${
            activeWallets.length <= 3 ? 'grid-cols-3' : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'
          }`}>
            {activeWallets.map(w => (
              <div
                key={w.id}
                className="bg-background/40 p-3 rounded-2xl border border-white/5"
                style={w.color ? { borderColor: `${w.color}15` } : {}}
              >
                <p className="text-[11px] text-muted flex items-center gap-1">
                  <span>{typeIcons[w.type] || '💰'}</span> {w.name}
                  {w.account_last4 && <span className="text-muted-dim font-mono">••{w.account_last4}</span>}
                </p>
                <p className="text-sm font-bold text-white mt-1">
                  {formatNaira(w.balance)}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* THIS MONTH PROGRESS */}
        <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3">
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="text-muted uppercase tracking-wider">This Month</span>
            {percentSpent != null && (
              <span className={percentSpent >= 100 ? 'text-red-400' : 'text-accent'}>
                {percentSpent}% of budget
              </span>
            )}
          </div>

          {percentSpent != null && (
            <div className="h-3 bg-background rounded-full overflow-hidden border border-white/5">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  percentSpent >= 100 ? 'bg-red-500' : 'bg-accent'
                }`}
                style={{ width: `${percentSpent}%` }}
              />
            </div>
          )}

          <p className="text-xs text-muted text-right">
            {formatNaira(totalSpent)} spent
            {percentSpent != null ? ` of ${formatNaira(budgetTarget)}` : ' — set a budget target in Settings'}
          </p>
        </section>

        {/* NEEDS ATTENTION */}
        <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-2">
            <span>⚠️</span> Needs Attention
          </h2>

          {unreviewedCount === 0 && lowWallets.length === 0 && dueDebts.length === 0 ? (
            <div className="flex items-center gap-2 text-accent text-sm font-medium pt-1">
              <span>✅</span> All clear! No items require review.
            </div>
          ) : (
            <div className="space-y-2">
              {/* Payments and payouts inside the week, plus anything overdue --
                  a missed contribution should not vanish just because its date
                  has passed. */}
              {dueDebts.map(({ debt, days, kind }) => (
                <Link
                  key={`${debt.id}-${kind}`}
                  to="/debts"
                  className={`flex items-center justify-between p-3 rounded-2xl text-xs font-semibold transition-all min-h-[48px] ${
                    kind === 'payout'
                      ? 'bg-blue-500/10 border border-blue-500/20 text-blue-300 hover:bg-blue-500/20'
                      : days < 0
                        ? 'bg-red-500/10 border border-red-500/20 text-red-300 hover:bg-red-500/20'
                        : 'bg-orange-500/10 border border-orange-500/20 text-orange-300 hover:bg-orange-500/20'
                  }`}
                >
                  <span>
                    • {kind === 'payout' ? 'Ajo payout from' : 'Payment for'} {debt.counterparty}
                    {days < 0
                      ? ` — ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
                      : days === 0
                        ? ' — today'
                        : ` — in ${days} day${days === 1 ? '' : 's'}`}
                  </span>
                  <span className="font-bold">View →</span>
                </Link>
              ))}

              {unreviewedCount > 0 && (
                <Link
                  to="/transactions"
                  className="flex items-center justify-between p-3 rounded-2xl bg-orange-500/10 border border-orange-500/20 text-orange-300 text-xs font-semibold hover:bg-orange-500/20 transition-all min-h-[48px]"
                >
                  <span>• {unreviewedCount} transaction{unreviewedCount === 1 ? '' : 's'} need categorization/review</span>
                  <span className="text-orange-400 font-bold">Review →</span>
                </Link>
              )}

              {lowWallets.map(w => (
                <div
                  key={w.id}
                  className="flex items-center justify-between p-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-300 text-xs font-semibold"
                >
                  <span>• {w.name} balance low ({formatNaira(w.balance)} &lt; {formatNaira(warnThreshold)})</span>
                  <span className="text-red-400 font-bold">Warning</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* TODAY'S PRIORITIES */}
        {/* Today — the task list, typed and derived, tickable in place */}
        <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Today</h2>
            {todayTasks.length > 0 && (
              <span className="text-[10px] text-muted tabular-nums">
                {todayTasks.filter(doneOn).length}/{todayTasks.length} done
              </span>
            )}
          </div>

          <TodayList
            tasks={todayTasks}
            transactions={todayTransactions}
            busyId={togglingId}
            onToggle={toggleTask}
            onSaveTitle={saveTaskTitle}
            onDelete={deleteTask}
            onSaveReason={hasColumn('goals.blocked_reason') ? saveTaskReason : undefined}
            canAdd={todayTasks.filter((t) => (t.slot ?? 0) < GENERATED_SLOT_BASE).length < GENERATED_SLOT_BASE}
          />
        </section>

        <Yesterday
          transactions={yesterdayTransactions}
          tasks={yesterdayTasks}
          isDone={doneOn}
          liquidWalletIds={liquidWalletIds}
        />

        <ActivityGrid tasks={dayRows} isDone={doneOn} today={todayDate} />

        {/* Recent Transactions */}
        <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
              Recent Transactions
            </h2>
            <Link to="/transactions" className="text-xs font-semibold text-accent hover:underline">
              See all →
            </Link>
          </div>

          {transactions.length === 0 ? (
            <p className="text-xs text-muted py-4 text-center">No recent transactions</p>
          ) : (
            <div className="space-y-3">
              {transactions.map((t) => {
                const icon = getCategoryIcon(t.category)
                const isCredit = t.type === 'credit'
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between p-3 rounded-2xl bg-background/40 border border-white/5"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center text-base">
                        {icon}
                      </div>
                      <div>
                        <p className="text-xs font-bold text-white leading-tight">
                          {t.description || t.category}
                        </p>
                        <p className="text-[10px] text-muted mt-0.5">
                          {formatDate(t.transaction_date)}
                        </p>
                      </div>
                    </div>
                    <span className={`text-xs font-bold ${isCredit ? 'text-accent' : 'text-white'}`}>
                      {isCredit ? '+' : '-'}{formatNaira(t.amount)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>
        </>
      ) : (
        <WeekReview
          weekStart={weekStart}
          weekEnd={weekEnd}
          thisWeekTransactions={thisWeekTransactions}
          lastWeekTransactions={lastWeekTransactions}
          liquidWalletIds={liquidWalletIds}
          weeklyGoals={weeklyGoals}
          lastWeekGoals={lastWeekGoals}
          dailyTasks={dayRows}
          isDone={doneOn}
          today={todayDate}
        />
      )}
    </div>
  )
}
