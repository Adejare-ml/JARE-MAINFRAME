import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { formatDate, displayName, timeAgo } from '../lib/formatters'
import { toast } from '../lib/toast'
import CashReconciliation from '../components/CashReconciliation'
import ErrorState from '../components/ui/ErrorState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { useAuth } from '../hooks/useAuth'
import { summarizeMonth, safeToSpend, budgetPace } from '../lib/summary'
import { upcomingDebts, paidTotals } from '../lib/debts'
import { generateTasks } from '../lib/generateTasks'
import { isTaskDone, goalProgress, GENERATED_SLOT_BASE, REPO_METRIC, staleGoals, STALE_GOAL_DAYS } from '../lib/planning'
import { dailyInsight } from '../lib/insight'
import { currentStreak } from '../lib/activity'
import { hasColumn, pendingMigrations } from '../lib/schema'
import { summarizeRuns, STATUS, unwellJobs, quietWallets } from '../lib/health'
import { setupGaps } from '../lib/setup'
import { useEdgeFunctionStatus } from '../hooks/useEdgeFunctionStatus'
import TodayList from '../components/daily/TodayList'
import DictateDay from '../components/daily/DictateDay'
import DayBrief from '../components/daily/DayBrief'
import EndOfDay from '../components/daily/EndOfDay'
import Yesterday from '../components/daily/Yesterday'
import ActivityGrid from '../components/daily/ActivityGrid'
import UpcomingBills from '../components/daily/UpcomingBills'
import DiscoveredAccounts from '../components/daily/DiscoveredAccounts'
import DietCard from '../components/daily/DietCard'
import { DailyHQSkeleton } from '../components/ui/PageSkeleton'
import WeekReview from '../components/daily/WeekReview'
import { useNewIds } from '../components/daily/useNewIds'
import { useSystemStatus } from '../lib/useSystemStatus'
import { shortName } from '../lib/systemStatus'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import Readout from '../components/ui/Readout'
import Money from '../components/ui/Money'
import Stat from '../components/ui/Stat'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Button from '../components/ui/Button'
import Badge from '../components/ui/Badge'
import Segmented from '../components/ui/Segmented'
import StatusDot from '../components/ui/StatusDot'
import ProgressBar from '../components/ui/ProgressBar'
import Provenance from '../components/ui/Provenance'
import CategoryMark from '../components/ui/CategoryMark'
import Icon from '../components/ui/Icon'
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
  excludeDrafts,
  queueAge,
} from '../lib/queries'

/** Days of history the activity grid needs: eight whole weeks plus slack for
 *  whichever weekday today is. */
const GRID_DAYS = 63

/** When the day stops being something to plan and starts being something to
 *  account for. 18:00 local. */
const EVENING_HOUR = 18

export default function DailyHQ() {
  const { session } = useAuth()
  const ownerName = displayName(session?.user)
  const [wallets, setWallets] = useState([])
  const [transactions, setTransactions] = useState([])
  const [recentRows, setRecentRows] = useState([])
  const [debts, setDebts] = useState([])
  const [linkedRows, setLinkedRows] = useState([])
  // Every daily row in the grid window. Today's list, yesterday's count and the
  // activity grid are all derived from this one array.
  const [dailyTasks, setDailyTasks] = useState([])
  const [dayBrief, setDayBrief] = useState(null)
  // Recent sync_runs rows for every scheduled job, not only the bank-alert
  // audit: a stalled snapshot or recap used to show only in Settings and in
  // a morning push no phone has subscribed to. Read once for the whole app by
  // useSystemStatus (the status rail), not queried again here.
  const { rows: jobRuns } = useSystemStatus()
  // How many phones get the morning reminder. null until read (or behind
  // 031): "unknown" must not read as "none".
  const [subscriberCount, setSubscriberCount] = useState(null)
  const edgeFunctions = useEdgeFunctionStatus()
  const [togglingId, setTogglingId] = useState(null)
  const [mode, setMode] = useState('day')
  const [unreviewedCount, setUnreviewedCount] = useState(0)
  const [oldestUnreviewed, setOldestUnreviewed] = useState(null)
  const [staleGoalCount, setStaleGoalCount] = useState(0)
  const [warnThreshold, setWarnThreshold] = useState(10000)
  // Default until the user sets one in Settings; the bar hides at 0.
  const [budgetTarget, setBudgetTarget] = useState(85000)
  // How today's insight (below) is worded, not which fact it picks -- see
  // src/lib/insight.js. Set in Settings, Cleo-style.
  const [plannerVoice, setPlannerVoice] = useState('encouraging')
  const [loading, setLoading] = useState(true)
  // A ledger row that lands while the page is open (a QuickLog, an alert
  // through realtime) fades in; the first render's rows do not.
  const isNewTransaction = useNewIds(transactions.map((t) => t.id), !loading)
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
  const shortDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
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
      const [walletsRes, recentRes, countRes, settingsRes, monthRes, goalsRes, debtsRes, briefRes, linkedRes, pushRes, oldestRes, staleRes] =
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
            .in('key', ['low_balance_threshold', 'monthly_budget_target', 'planner_tone']),
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
            excludeDrafts(
              supabase
                .from('goals')
                .select('*')
                .in('period', ['daily', 'weekly'])
                .gte('target_date', daysAgo(GRID_DAYS)),
            ),
          ),
          supabase.from('debts').select('*').eq('settled', false),
          // Today's shape, from the overnight run. Additive like debts: a page
          // that fails because the calendar could not be read would let the
          // optional half of this break the half you rely on.
          hasColumn('day_briefs.brief_date')
            ? supabase.from('day_briefs').select('*').eq('brief_date', todayDate).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
          // Repayments linked to a debt (029, and the ingest function links
          // them itself since 039): a loan the ledger has paid off must not
          // keep reading "overdue" here.
          hasColumn('transactions.debt_id')
            ? supabase.from('transactions').select('id, debt_id, type, amount, voided').not('debt_id', 'is', null)
            : Promise.resolve({ data: [], error: null }),
          // A head count of subscribed phones, for the setup checklist: a
          // digest that reaches nobody is the failure that card exists for.
          hasColumn('push_subscriptions.endpoint')
            ? supabase.from('push_subscriptions').select('id', { count: 'exact', head: true })
            : Promise.resolve({ count: null, error: null }),
          // The oldest row waiting in review, so the queue line has an age.
          excludeVoided(
            supabase
              .from('transactions')
              .select('transaction_date')
              .eq(NEEDS_REVIEW_FILTER.column, NEEDS_REVIEW_FILTER.value),
          )
            .order('transaction_date', { ascending: true })
            .limit(1)
            .maybeSingle(),
          // Open, hand-made goals from periods long over: a line here, and
          // Close / Roll on the Goals page. Additive.
          excludeDrafts(
            supabase
              .from('goals')
              .select('id, title, period, target_date, completed, parent_id')
              .eq('completed', false)
              .is('parent_id', null)
              .lt('target_date', daysAgo(STALE_GOAL_DAYS))
              .limit(50),
          ),
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
      if (linkedRes.error) console.warn('Linked repayments unavailable:', linkedRes.error.message)
      setLinkedRows(linkedRes.error ? [] : linkedRes.data || [])

      if (briefRes.error) console.warn('Day brief unavailable:', briefRes.error.message)
      setDayBrief(briefRes.error ? null : briefRes.data || null)
      if (pushRes.error) console.warn('Reminder devices unavailable:', pushRes.error.message)
      setSubscriberCount(pushRes.error ? null : pushRes.count ?? null)
      setOldestUnreviewed(oldestRes.error ? null : oldestRes.data?.transaction_date || null)
      if (staleRes.error) console.warn('Stale goals unavailable:', staleRes.error.message)
      setStaleGoalCount(staleRes.error ? 0 : staleGoals(staleRes.data || [], todayDate).length)

      setWallets(walletsRes.data || [])
      setTransactions(recentRes.data || [])
      setUnreviewedCount(countRes.count || 0)
      setRecentRows(monthRes.data || [])
      setDailyTasks(goalsRes.data || [])

      for (const row of settingsRes.data || []) {
        if (row.key === 'planner_tone') {
          if (row.value === 'stern' || row.value === 'encouraging') setPlannerVoice(row.value)
          continue
        }
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

  /**
   * Add several tasks at once, from one thing said or typed.
   *
   * Slots are claimed in one pass rather than by calling saveTaskTitle in a
   * loop: that would recompute the free slot from `dailyTasks`, which has not
   * been refetched yet, so every task in a dictation would be handed the same
   * slot and the upsert would collapse three tasks into one.
   */
  const addTasks = async (titles) => {
    const taken = new Set(
      dailyTasks
        .filter((t) => t.period === 'daily' && t.target_date === todayDate && t.slot != null)
        .map((t) => t.slot),
    )

    const rows = []
    let slot = 0
    for (const title of titles) {
      while (slot < GENERATED_SLOT_BASE && taken.has(slot)) slot++
      if (slot >= GENERATED_SLOT_BASE) break
      taken.add(slot)
      rows.push({ title, slot, period: 'daily', target_date: todayDate })
    }

    if (rows.length === 0) {
      toast.error('That is ten priorities for one day — finish one first')
      return
    }

    const { error } = await supabase
      .from('goals')
      .upsert(rows, { onConflict: 'period,target_date,slot' })

    if (error) {
      toast.error('Failed to save: ' + error.message)
      return
    }
    toast.success(`Added ${rows.length} ${rows.length === 1 ? 'priority' : 'priorities'}`)
    fetchDailyData()
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
    return <DailyHQSkeleton />
  }

  if (pageError) {
    return (
      <div className="space-y-3 pb-6">
        <PageHeader title={`${greeting}, ${ownerName}`} meta={shortDate} />
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

  const dueDebts = upcomingDebts(debts, 7, new Date(), paidTotals(debts, linkedRows))

  // Bank alerts arrive through the morning audit; if it stops, every figure
  // on this page quietly freezes while still looking current. Same 30-hour
  // patience as Settings → System, and "never" counts too.
  const jobHealth = summarizeRuns(jobRuns)
  const auditJob = jobHealth.find((j) => j.id === 'claude-audit')
  // Red when the audit is broken, stopped, never ran, or recorded nothing on
  // a mailbox that normally has alerts; amber when it ran and skipped one
  // alert (its summary says which).
  const auditUnwell = hasColumn('sync_runs.job') && auditJob && (auditJob.status !== STATUS.OK || auditJob.suspect)
  // The other jobs matter less per day, so only a failure or a run that is
  // overdue by its own patience makes the list (one rule, shared with the
  // morning reminder: unwellJobs); one that has never run is a Settings
  // fact, not a morning alarm. A job that ran and found a data problem
  // (reconcile's missed alerts) is listed in amber with what it found.
  const stalledJobs = hasColumn('sync_runs.job') ? unwellJobs(jobHealth).filter((j) => j.id !== 'claude-audit') : []
  const attentionJobs = hasColumn('sync_runs.job')
    ? jobHealth.filter((j) => j.id !== 'claude-audit' && j.id !== 'backup' && j.status === STATUS.ATTENTION)
    : []
  // Banks that have gone quiet: the audit can be running every morning and
  // still never hear from a wallet whose sender changed or whose alerts
  // stopped. Stanbic had never sent one.
  const silentWallets = quietWallets(activeWallets)
  // The owner's undone setup steps, in the schema banner's voice.
  const setupRows = setupGaps({
    subscriberCount,
    askStatus: edgeFunctions.ask,
    mealStatus: edgeFunctions.meal,
    backupJob: hasColumn('sync_runs.job') ? jobHealth.find((j) => j.id === 'backup') : null,
    pendingMigrations: pendingMigrations(),
  })

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

  // A task is "unknown" rather than missed when it is a repo goal the nightly
  // verifier has not checked yet -- almost always today's own cell, before
  // that Action has run for the day. See activity.js's buildActivityGrid.
  const isUnknownTask = (task) =>
    task.metric === REPO_METRIC && !task.verified_at && !task.completed

  const streak = currentStreak(dayRows, doneOn, { today: todayDate })

  // Every liquid wallet, active or not: a deactivated wallet keeps its
  // history, and dropping it from the counted set erased every past month's
  // spending from it. Active-only stays right for balances, above.
  const liquidWalletIds = new Set(
    wallets.filter(w => ['bank', 'mobile', 'cash'].includes(w.type)).map(w => w.id),
  )
  const monthSummary = summarizeMonth(monthTransactions, liquidWalletIds)
  const totalSpent = monthSummary.spent

  // Money already spoken for: today's and this week's save_at_least targets,
  // each judged against the same correctly-scoped transactions TodayList and
  // WeekReview already use for the same goals -- a daily target against a
  // week of transactions would overcount what is left to save.
  const committedGoals = [...todayTasks, ...weeklyGoals]
    .filter((g) => g.metric === 'save_at_least')
    .reduce((sum, g) => {
      const progress = goalProgress(g, g.period === 'daily' ? todayTransactions : thisWeekTransactions, { liquidWalletIds })
      return sum + Math.max(0, (progress.target || 0) - (progress.done || 0))
    }, 0)

  const safeToSpendToday = safeToSpend({
    liquidBalance,
    spent: totalSpent,
    budgetTarget,
    committedGoals,
  })
  const percentSpent = budgetTarget > 0
    ? Math.min(Math.round((totalSpent / budgetTarget) * 100), 100)
    : null

  // Same shape Budget.jsx already computes independently -- neither page
  // fetches the other's data, so each works this out from what it has.
  const now = new Date()
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const pace = budgetPace(budgetTarget, totalSpent, now.getDate(), daysInMonth)

  const overdueDebts = dueDebts.filter((d) => d.days < 0)

  const insight = dailyInsight({
    lowWallets,
    overdueDebts,
    totalSpent,
    budgetTarget,
    pace,
    streak,
    safeToSpendToday,
    voice: plannerVoice,
  })

  // One word for the money situation, read straight off the same figures
  // "Safe to spend" and the month-progress bar already show.
  const statusChip = budgetTarget > 0
    ? (percentSpent >= 100 || safeToSpendToday <= 0)
      ? 'Over'
      : pace && !pace.onTrack
        ? 'Watch it'
        : 'On track'
    : null

  // Attention items, in the order they always had: setup steps first (until
  // a phone is subscribed, this list is the only place the alarms below
  // reach), then the system, then money owed, then the queue.
  const attention = []
  for (const row of setupRows) {
    attention.push({ key: `setup-${row.id}`, tone: 'warn', to: row.to, title: SETUP_TITLES[row.id] || 'Finish setup', subtitle: row.text })
  }
  if (auditUnwell) {
    attention.push({
      key: 'audit',
      tone: auditJob.status === STATUS.ATTENTION ? 'warn' : 'danger',
      to: '/settings#system',
      title: 'Bank alerts',
      subtitle: auditJob.suspect
        ? auditJob.suspectReason
        : auditJob.status === STATUS.ATTENTION
          ? `Read this morning, but ${auditJob.reason}`
          : auditJob.status === STATUS.FAILING
            ? 'Failing. The figures here may be stale.'
            : auditJob.status === STATUS.NEVER
              ? 'Never recorded. The figures here may be stale.'
              : `Last recorded ${timeAgo(auditJob.lastRun.finished_at)}. The figures here may be stale.`,
    })
  }
  for (const job of attentionJobs) {
    attention.push({ key: `att-${job.id}`, tone: 'warn', to: '/settings#system', title: shortName(job), subtitle: job.reason })
  }
  for (const { wallet, status, daysSince } of silentWallets) {
    attention.push({
      key: `quiet-${wallet.id}`,
      tone: 'warn',
      to: '/settings',
      title: `${wallet.name} has gone quiet`,
      subtitle: `${status === 'never' ? 'Has never sent an alert' : `No alert for ${daysSince} days`}. Check ${wallet.alert_sender}.`,
    })
  }
  for (const job of stalledJobs) {
    attention.push({
      key: `stall-${job.id}`,
      tone: job.status === STATUS.FAILING ? 'danger' : 'warn',
      to: '/settings#system',
      title: shortName(job),
      subtitle: job.status === STATUS.FAILING
        ? `Failing, last run ${timeAgo(job.lastRun.finished_at)}`
        : `Not run since ${timeAgo(job.lastRun.finished_at)}`,
    })
  }
  // Payments and payouts inside the week, plus anything overdue: a missed
  // contribution should not vanish just because its date has passed.
  for (const { debt, days, kind } of dueDebts) {
    attention.push({
      key: `debt-${debt.id}-${kind}`,
      tone: kind === 'payout' ? 'muted' : days < 0 ? 'danger' : 'warn',
      to: '/debts',
      title: `${kind === 'payout' ? 'Ajo payout from' : 'Payment for'} ${debt.counterparty}`,
      subtitle: days < 0
        ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`
        : days === 0
          ? 'Due today'
          : `Due in ${days} day${days === 1 ? '' : 's'}`,
    })
  }
  if (unreviewedCount > 0) {
    const age = queueAge(oldestUnreviewed, todayDate)
    attention.push({
      key: 'review',
      tone: 'warn',
      to: '/transactions?filter=Review',
      title: `${unreviewedCount} transaction${unreviewedCount === 1 ? '' : 's'} to review`,
      subtitle: `Needs a category or a check${age && age.days > 0 ? `, ${age.label}` : ''}`,
    })
  }
  if (staleGoalCount > 0) {
    attention.push({
      key: 'stale-goals',
      tone: 'warn',
      to: '/goals',
      title: `${staleGoalCount} goal${staleGoalCount === 1 ? ' is' : 's are'} past ${staleGoalCount === 1 ? 'its' : 'their'} date`,
      subtitle: `Close or roll ${staleGoalCount === 1 ? 'it' : 'them'}`,
    })
  }
  for (const w of lowWallets) {
    attention.push({
      key: `low-${w.id}`,
      tone: 'danger',
      title: `${w.name} balance low`,
      subtitle: (
        <>
          <Money amount={w.balance} tone="muted" /> is under <Money amount={warnThreshold} tone="muted" />
        </>
      ),
    })
  }

  const doneCount = todayTasks.filter(doneOn).length
  const meta = [shortDate, streak > 0 ? `${streak}-day streak` : null].filter(Boolean).join(' · ')
  const chip = statusChip ? { Over: 'danger', 'Watch it': 'warn', 'On track': 'accent' }[statusChip] : null
  const insightDot = { warn: 'danger', watch: 'warn', good: 'accent' }[insight.tone] || 'muted'

  return (
    <div className="space-y-3 pb-6">
      <PageHeader
        title={mode === 'day' ? `${greeting}, ${ownerName}` : 'How the week went'}
        meta={mode === 'day' ? meta : `Week of ${formatDate(weekStart)}`}
        actions={
          <Segmented
            tabs
            idPrefix="hq"
            label="Time range"
            options={[
              { value: 'day', label: 'Day' },
              { value: 'week', label: 'Week' },
            ]}
            value={mode}
            onChange={setMode}
          />
        }
      />

      <div id={`hq-panel-${mode}`} role="tabpanel" aria-labelledby={`hq-tab-${mode}`} className="space-y-3">
        {mode === 'day' ? (
          <>
            {/* The hero: what can be spent today, the month it sits in, and
                one sentence chosen from those same numbers (src/lib/insight.js). */}
            <Panel label="Safe to spend" action={statusChip && <Badge label={statusChip} tone={chip} />}>
              <Readout
                size="display"
                value={safeToSpendToday}
                tone={safeToSpendToday < 0 ? 'danger' : 'default'}
                sub={
                  committedGoals > 0 ? (
                    <>
                      After <Money amount={committedGoals} kobo={false} tone="muted" /> still owed to goals.
                    </>
                  ) : (
                    'After the money already spoken for.'
                  )
                }
              />
              <div className="mt-3 space-y-1.5">
                {percentSpent != null && (
                  <ProgressBar
                    value={percentSpent}
                    tone={percentSpent >= 100 ? 'danger' : pace && !pace.onTrack ? 'warn' : 'accent'}
                    label="Share of this month's budget spent"
                  />
                )}
                <p className="flex items-baseline justify-between gap-3 text-body-sm text-muted">
                  <span className="min-w-0">
                    <Money amount={totalSpent} kobo={false} /> spent this month
                    {percentSpent == null && ', set a budget target in Settings'}
                  </span>
                  {percentSpent != null && (
                    <span className="type-data shrink-0">
                      {percentSpent}% of <Money amount={budgetTarget} kobo={false} tone="muted" className="font-normal" />
                    </span>
                  )}
                </p>
              </div>
              <p className="mt-2.5 flex items-start gap-2.5 text-body-sm text-foreground">
                <StatusDot status={insightDot} className="mt-1.5" />
                <span className="money whitespace-normal">{insight.text}</span>
              </p>
            </Panel>

            {/* Today's food, with the add-food sheet one tap away. */}
            <DietCard />

            {/* What needs a decision. The first row is the next reminder. */}
            <Panel label="Needs attention" meta={attention.length > 0 ? `${attention.length} item${attention.length === 1 ? '' : 's'}` : null} flush>
              {attention.length === 0 ? (
                <ListRow leading={<StatusDot status="ok" />} title="All clear" subtitle="Nothing needs you right now." />
              ) : (
                <ListRows>
                  {attention.map((item) => (
                    <ListRow
                      key={item.key}
                      to={item.to}
                      wrap
                      leading={<StatusDot status={item.tone} />}
                      title={item.title}
                      subtitle={item.subtitle}
                      trailing={item.to ? <Icon name="chevR" size={18} className="text-muted" /> : null}
                    />
                  ))}
                </ListRows>
              )}
            </Panel>

            {/* What today already has in it. */}
            <DayBrief brief={dayBrief} />

            {/* Today: the task list, typed and derived, tickable in place. */}
            <Panel label="Today" meta={todayTasks.length > 0 ? `${doneCount}/${todayTasks.length} done` : null} flush>
              {/* Say the day, or type it. The textarea is the baseline and the
                  microphone is an accelerator on top (src/lib/speech.js). */}
              <DictateDay
                onAdd={addTasks}
                busy={Boolean(togglingId)}
                remaining={GENERATED_SLOT_BASE - todayTasks.filter((t) => (t.slot ?? 0) < GENERATED_SLOT_BASE).length}
              />
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
            </Panel>

            {/* Asked once, in the evening, and only about what is still open. */}
            {currentHour >= EVENING_HOUR && (
              <EndOfDay
                open={todayTasks.filter((t) => !doneOn(t))}
                onToggle={toggleTask}
                onSaveReason={hasColumn('goals.blocked_reason') ? saveTaskReason : undefined}
                busyId={togglingId}
              />
            )}

            {/* The evening cash check (after 20:00 only). */}
            <CashReconciliation onReconciled={fetchDailyData} />

            {/* Accounts the morning audit saw in the mail and does not track
                yet (043); bills found from the pattern alone. Each renders
                nothing when there is nothing to decide. */}
            <DiscoveredAccounts />
            <UpcomingBills />

            {/* Wallets */}
            <Panel label="Wallets" meta={`${activeWallets.length} active`} flush>
              <div className="px-3 pt-3 pb-3 lg:px-4 space-y-3 border-b border-border">
                <Readout label="Total" value={totalBalance} />
                {hasSavingsOrInvestments && (
                  <div className="grid grid-cols-3 gap-3">
                    <Stat label="Liquid" value={<Money amount={liquidBalance} kobo={false} />} />
                    <Stat label="Savings" value={<Money amount={savingsBalance} kobo={false} />} />
                    <Stat label="Invested" value={<Money amount={investmentBalance} kobo={false} />} />
                  </div>
                )}
              </div>
              <ListRows>
                {activeWallets.map((w) => (
                  <ListRow
                    key={w.id}
                    leading={
                      <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 rounded-chip bg-surface-2 text-muted">
                        <Icon name={WALLET_GLYPH[w.type] || 'budget'} size={16} />
                      </span>
                    }
                    title={w.name}
                    subtitle={
                      <>
                        <span className="capitalize">{w.type}</span>
                        {w.account_last4 && <span className="type-data"> ··{w.account_last4}</span>}
                      </>
                    }
                    trailing={<Money amount={w.balance} />}
                  />
                ))}
              </ListRows>
            </Panel>

            <Panel label="Recent" flush action={<Button size="sm" variant="ghost" to="/transactions">See all</Button>}>
              {transactions.length === 0 ? (
                <ListRow title="No recent transactions" subtitle="Alerts and logged spending land here." />
              ) : (
                <ListRows>
                  {transactions.map((t) => {
                    const isCredit = t.type === 'credit'
                    return (
                      <ListRow
                        key={t.id}
                        isNew={isNewTransaction(t.id)}
                        leading={<CategoryMark category={t.category} />}
                        title={t.description || t.category}
                        subtitle={`${t.category} · ${t.transaction_date === todayDate ? 'Today' : t.transaction_date === yesterdayDate ? 'Yesterday' : formatDate(t.transaction_date)}`}
                        meta={<Provenance source={t.source} at={t.transaction_time} />}
                        trailing={<Money amount={isCredit ? Number(t.amount) : -Number(t.amount)} sign={isCredit} tone={isCredit ? 'positive' : 'default'} />}
                      />
                    )
                  })}
                </ListRows>
              )}
            </Panel>

            <Yesterday transactions={yesterdayTransactions} tasks={yesterdayTasks} isDone={doneOn} liquidWalletIds={liquidWalletIds} />

            <ActivityGrid tasks={dayRows} isDone={doneOn} today={todayDate} isUnknown={isUnknownTask} />
          </>
        ) : (
          <WeekReview
            weekStart={weekStart}
            weekEnd={weekEnd}
            lastWeekStart={lastWeekStart}
            thisWeekTransactions={thisWeekTransactions}
            lastWeekTransactions={lastWeekTransactions}
            liquidWalletIds={liquidWalletIds}
            weeklyGoals={weeklyGoals}
            lastWeekGoals={lastWeekGoals}
            dailyTasks={dayRows}
            isDone={doneOn}
            isLastWeekGoalDone={(goal) => isTaskDone(goal, lastWeekTransactions)}
            today={todayDate}
          />
        )}
      </div>
    </div>
  )
}

/** Plain titles for the setup checklist's rows (src/lib/setup.js ids). */
const SETUP_TITLES = {
  migrations: 'Database is behind the app',
  push: 'Morning reminder reaches nobody',
  backup: 'Backup is not set up',
  functions: 'Edge functions not deployed',
  'meal-key': 'Photo reading has no key',
}

/** A wallet's type as a glyph. */
const WALLET_GLYPH = { bank: 'bank', mobile: 'phone', cash: 'cash', savings: 'vault', investment: 'chart' }
