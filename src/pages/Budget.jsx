import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import CategoryBreakdown from '../components/ui/CategoryBreakdown'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import NetWorthSparkline from '../components/ui/NetWorthSparkline'
import MonthRecap from '../components/ui/MonthRecap'
import { BudgetSkeleton } from '../components/ui/PageSkeleton'
import { openQuickLog } from '../components/ui/QuickLog'
import { timeAgo, formatDate } from '../lib/formatters'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { summarizeMonth, runway, safeToSpend, budgetPace, categoryAverages } from '../lib/summary'
import { excludeRefunded } from '../lib/refunds'
import { buildMonthRecap } from '../lib/monthRecap'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Money from '../components/ui/Money'
import Readout from '../components/ui/Readout'
import Stat from '../components/ui/Stat'
import Button from '../components/ui/Button'
import IconButton from '../components/ui/IconButton'
import ProgressBar from '../components/ui/ProgressBar'
import StatusDot from '../components/ui/StatusDot'
import CategoryMark from '../components/ui/CategoryMark'
import Provenance from '../components/ui/Provenance'
import {
  transactionListColumns,
  transactionSummaryColumns,
  transactionRecurrenceColumns,
  startOfMonth,
  endOfMonth,
  shiftMonth,
  parseMonthParam,
  isCurrentMonth,
  daysAgo,
  excludeVoided,
} from '../lib/queries'

/** Past calendar months of history read for the category-average figures --
 *  long enough for one bad month not to dominate the average, short enough
 *  to stay one cheap query. */
const AVERAGE_MONTHS = 3

/** Split a flat row of transactions into one array per calendar month, so
 *  categoryAverages() -- which does no date math of its own, by design --
 *  gets pre-bucketed input. Local to this page: nothing else needs it yet. */
function bucketByMonth(transactions) {
  const byMonth = new Map()
  for (const t of transactions || []) {
    const key = (t.transaction_date || '').slice(0, 7)
    if (!key) continue
    if (!byMonth.has(key)) byMonth.set(key, [])
    byMonth.get(key).push(t)
  }
  return [...byMonth.values()]
}

export default function Budget() {
  const [wallets, setWallets] = useState([])
  // Two scoped queries rather than one unbounded fetch: this page only ever
  // shows the current month's totals and the five most recent rows, so pulling
  // the whole table (with email bodies attached) was paying for the entire
  // ledger to render eight numbers.
  const [monthTransactions, setMonthTransactions] = useState([])
  const [recentTransactions, setRecentTransactions] = useState([])
  const [netWorthHistory, setNetWorthHistory] = useState([])
  // Per-category targets (migration 024) and the prior months' transactions
  // the average figure is computed from -- both additive, like
  // netWorthHistory above: a database behind 024, or simply no history yet,
  // must not take down a page that has worked without either.
  const [categoryBudgets, setCategoryBudgets] = useState([])
  const [averageWindowTransactions, setAverageWindowTransactions] = useState([])
  // Same default and same key as Daily HQ reads -- one budget target, read the
  // same way in both places, or the two pages would disagree about it.
  const [budgetTarget, setBudgetTarget] = useState(85000)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  // Which month the page shows: `?month=YYYY-MM`, or this one. Balances,
  // runway and safe-to-spend are facts about now, so a past month shows
  // only what happened in it.
  const [searchParams, setSearchParams] = useSearchParams()
  const viewMonthStart = startOfMonth(parseMonthParam(searchParams.get('month')) || new Date())
  const isCurrent = isCurrentMonth(new Date(viewMonthStart + 'T00:00:00'))

  const fetchWalletsAndData = useCallback(async () => {
    try {
      setPageError(null)
      const monthDate = new Date(viewMonthStart + 'T00:00:00')
      const monthEnd = endOfMonth(monthDate)
      const averageWindowStart = startOfMonth(shiftMonth(monthDate, -AVERAGE_MONTHS))

      const [walletsRes, monthRes, recentRes, settingsRes, netWorthRes, categoryBudgetsRes, averageWindowRes] = await Promise.all([
        supabase.from('wallets').select('*').order('name'),
        // Totals are keyed on transaction_date -- the date the bank says the
        // money moved -- not created_at, which is when the sync happened. A
        // backfill inserts last month's transactions today, and keying on
        // created_at counted every one of them against this month.
        // Recurrence columns (payee and narration too): a refund is paired
        // with its charge by payee, see src/lib/refunds.js.
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionRecurrenceColumns())
            .gte('transaction_date', viewMonthStart)
            .lte('transaction_date', monthEnd),
        ),
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionListColumns())
            .lte('transaction_date', monthEnd)
            .order('transaction_date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(5),
        ),
        supabase.from('user_settings').select('key, value').eq('key', 'monthly_budget_target'),
        // Additive, like day_briefs on Daily HQ: a database where 018 has not
        // run yet must not take down a page that has worked without this
        // table since before it existed. The sparkline just shows nothing.
        supabase
          .from('wallet_snapshots')
          .select('snapshot_date, total_balance')
          .gte('snapshot_date', daysAgo(90))
          .order('snapshot_date', { ascending: true }),
        // Additive, same reasoning as wallet_snapshots above: a database
        // behind 024 must cost only the envelope bars, not this page.
        supabase.from('category_budgets').select('category, target_amount'),
        // Prior months only, excluding the current one -- this month is
        // already shown as its own figure, and folding a partial month into
        // an "average" would understate every other month it's compared
        // against.
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionSummaryColumns())
            .gte('transaction_date', averageWindowStart)
            .lt('transaction_date', viewMonthStart),
        ),
      ])

      if (walletsRes.error) throw walletsRes.error
      if (monthRes.error) throw monthRes.error
      if (recentRes.error) throw recentRes.error

      setWallets(walletsRes.data || [])
      setMonthTransactions(monthRes.data || [])
      setRecentTransactions(recentRes.data || [])
      setNetWorthHistory(netWorthRes.error ? [] : netWorthRes.data || [])
      setCategoryBudgets(categoryBudgetsRes.error ? [] : categoryBudgetsRes.data || [])
      setAverageWindowTransactions(averageWindowRes.error ? [] : averageWindowRes.data || [])

      // Additive, like Daily HQ's own read of the same key: a missing table or
      // an unset target leaves the default rather than failing the page.
      const targetRow = (settingsRes.data || [])[0]
      if (targetRow) {
        const parsed = parseFloat(targetRow.value)
        if (!isNaN(parsed) && parsed >= 0) setBudgetTarget(parsed)
      }
    } catch (error) {
      console.error('Error fetching data:', error)
      // Without this, a network failure left wallets empty and the setup gate
      // below replaced the whole page with a first-run wallet-creation screen.
      setPageError(error.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [viewMonthStart])

  useEffect(() => {
    fetchWalletsAndData()
  }, [fetchWalletsAndData])

  useRealtimeRefresh(['wallets', 'transactions'], fetchWalletsAndData, {
    channelPrefix: 'budget',
  })

  if (loading) {
    return <BudgetSkeleton />
  }

  if (pageError) {
    return (
      <div className="space-y-3 pb-6">
        <PageHeader title="Budget" />
        <ErrorState message={pageError} onRetry={fetchWalletsAndData} />
      </div>
    )
  }

  // Genuinely no wallets yet (and no error hiding them). The old gate required
  // the literal names GTBank, OPay and Cash to all exist -- renaming one in
  // Settings replaced this whole page with a setup screen forever, whose
  // Activate button created wallets with no alert_sender and no parse_strategy,
  // so they could never sync. Settings already has the complete add-wallet
  // form; point there instead of maintaining a second, worse one.
  if (wallets.length === 0) {
    return (
      <div className="space-y-3 pb-6">
        <PageHeader title="Budget" />
        <Panel>
          <div className="text-center py-8 px-2">
            <p className="text-heading text-foreground">No wallets yet</p>
            <p className="text-body-sm text-muted max-w-sm mx-auto mt-1">
              Add your bank accounts, Opay and cash in Settings, each with its slug (gtbank,
              opay, stanbic), which is how the morning import files bank alerts to it.
            </p>
            <div className="mt-5">
              <Button to="/settings">Set up wallets</Button>
            </div>
          </div>
        </Panel>
      </div>
    )
  }

  // ── Layered Net Worth Calculations ──
  const activeWallets = wallets.filter(w => w.is_active !== false)
  const liquidWallets = activeWallets.filter(w => ['bank', 'mobile', 'cash'].includes(w.type))
  const savingsWallets = activeWallets.filter(w => w.type === 'savings')
  const investmentWallets = activeWallets.filter(w => w.type === 'investment')

  const liquidBalance = liquidWallets.reduce((sum, w) => sum + (Number(w.balance) || 0), 0)
  const savingsBalance = savingsWallets.reduce((sum, w) => sum + (Number(w.balance) || 0), 0)
  const investmentBalance = investmentWallets.reduce((sum, w) => sum + (Number(w.balance) || 0), 0)
  const totalNetWorth = liquidBalance + savingsBalance + investmentBalance
  
  let latestLastUpdated = null
  wallets.forEach(w => {
    if (!latestLastUpdated || new Date(w.updated_at) > new Date(latestLastUpdated)) {
      latestLastUpdated = w.updated_at
    }
  })

  // This Month summary — scoped to the month by the query, with transfer
  // categories (Savings Transfer, Cash Withdrawal, Cash Received) excluded
  // from income/spent and reported as movedAside. Excluding by wallet alone
  // was not enough: a GTBank→PiggyVest transfer writes its debit leg on the
  // liquid side, so saving money read as spending it, and ATM cash counted
  // twice. The math lives in src/lib/summary.js with tests.
  // Every liquid wallet, active or not (see DailyHQ): deactivating a wallet
  // must not erase its past months from these totals.
  const liquidWalletIds = new Set(
    wallets.filter(w => ['bank', 'mobile', 'cash'].includes(w.type)).map(w => w.id),
  )
  // A refunded charge and its refund are left out of both sides: neither
  // was spending, neither was income.
  const { rows: nettedTransactions, netted: refundsNetted } = excludeRefunded(monthTransactions)
  const monthSummary = summarizeMonth(nettedTransactions, liquidWalletIds)

  // category -> target, and category -> historical average, both optional
  // lookups CategoryBreakdown defaults to {} for when 024 has not run or
  // there is not yet enough history -- see that component's own comment.
  const budgetByCategory = Object.fromEntries(
    categoryBudgets.map((b) => [b.category, Number(b.target_amount) || 0]),
  )
  const averageByCategory = Object.fromEntries(
    categoryAverages(bucketByMonth(averageWindowTransactions), liquidWalletIds)
      .map((a) => [a.category, a.average]),
  )

  // The month in review: the viewed month against the one before it. On
  // the current month it appears for the first week only and describes
  // last month, which has just closed; a past month describes itself.
  const monthBuckets = new Map(
    bucketByMonth(averageWindowTransactions).map((rows) => [rows[0].transaction_date.slice(0, 7), rows]),
  )
  const monthKey = (d) => startOfMonth(d).slice(0, 7)
  const viewDate = new Date(viewMonthStart + 'T00:00:00')
  const recapMonthDate = isCurrent ? shiftMonth(viewDate, -1) : viewDate
  const showRecap = !isCurrent || new Date().getDate() <= 7
  const recapRows = isCurrent ? monthBuckets.get(monthKey(recapMonthDate)) || [] : nettedTransactions
  const recapSentences = showRecap
    ? buildMonthRecap({
        thisMonth: recapRows,
        lastMonth: monthBuckets.get(monthKey(shiftMonth(recapMonthDate, -1))) || [],
        liquidWalletIds,
        budgetByCategory,
        refundsNetted: isCurrent ? 0 : refundsNetted,
        label: recapMonthDate.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }),
      })
    : []

  const thisMonthIncome = monthSummary.income
  const thisMonthSpent = monthSummary.spent
  const thisMonthRemaining = liquidBalance
  const monthRunway = runway(liquidBalance, thisMonthSpent, new Date().getDate())
  // Budget-vs-balance only -- unlike Daily HQ's version, this page fetches no
  // goals, so it cannot net out what is still owed toward one. Deliberate:
  // Daily HQ is the goals-aware daily decision surface; this is the monthly
  // overview, and a second goals fetch here would be paying for a figure this
  // page does not otherwise need.
  const safeToSpendThisMonth = safeToSpend({ liquidBalance, spent: thisMonthSpent, budgetTarget })

  const today = new Date()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const percentOfBudget = budgetTarget > 0 ? Math.round((thisMonthSpent / budgetTarget) * 100) : null
  const pace = budgetPace(budgetTarget, thisMonthSpent, today.getDate(), daysInMonth)

  const last5Transactions = recentTransactions

  const hasSavingsOrInvestments = savingsWallets.length > 0 || investmentWallets.length > 0

  const monthLabel = new Date(viewMonthStart + 'T00:00:00').toLocaleDateString('en-NG', { month: 'long', year: 'numeric' })
  const goToMonth = (n) => {
    const next = shiftMonth(new Date(viewMonthStart + 'T00:00:00'), n)
    if (isCurrentMonth(next)) setSearchParams({})
    else setSearchParams({ month: startOfMonth(next).slice(0, 7) })
  }

  return (
    <div className="space-y-3 pb-6">
      <PageHeader
        title="Budget"
        meta={`Updated ${latestLastUpdated ? timeAgo(latestLastUpdated) : 'just now'}`}
        actions={
          <Button size="sm" variant="ghost" icon="repair" to="/repairs">
            Repairs
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-2">
        <Button size="sm" variant="secondary" icon="plus" onClick={() => openQuickLog('debit')}>
          Log
        </Button>
        <Button size="sm" variant="secondary" icon="repeat" onClick={() => openQuickLog('transfer')}>
          Transfer
        </Button>
        <Button size="sm" variant="secondary" icon="arrowIn" onClick={() => openQuickLog('credit')}>
          Income
        </Button>
      </div>

      {/* Net worth: the page's one display figure, the trend under it and
          the three layers it is made of. */}
      <Panel label="Total net worth">
        <Readout size="display" value={totalNetWorth} tone={totalNetWorth < 0 ? 'danger' : 'default'} />
        <div className="mt-3">
          <NetWorthSparkline snapshots={netWorthHistory} />
        </div>
        {hasSavingsOrInvestments && (
          <div className="grid grid-cols-3 gap-3 mt-3 pt-3 border-t border-border">
            <Stat label="Liquid" value={<Money amount={liquidBalance} kobo={false} />} />
            <Stat label="Savings" value={<Money amount={savingsBalance} kobo={false} />} />
            <Stat label="Invested" value={<Money amount={investmentBalance} kobo={false} />} />
          </div>
        )}
      </Panel>

      {/* Wallets */}
      <Panel label="Wallets" meta={`${activeWallets.length} active`} flush>
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
              subtitle={<span className="capitalize">{w.type}</span>}
              trailing={<Money amount={Number(w.balance) || 0} />}
            />
          ))}
        </ListRows>
      </Panel>

      {/* The month: safe to spend against the target, then income, spending
          and what was moved aside. Arrows step through past months. */}
      <Panel
        label={isCurrent ? 'This month' : monthLabel}
        action={
          <div className="flex items-center -mr-2">
            {!isCurrent && (
              <Button size="sm" variant="ghost" onClick={() => setSearchParams({})}>
                This month
              </Button>
            )}
            <IconButton name="chevL" label="Previous month" onClick={() => goToMonth(-1)} />
            <IconButton name="chevR" label="Next month" onClick={() => goToMonth(1)} disabled={isCurrent} />
          </div>
        }
      >
        {!isCurrent && percentOfBudget != null && (
          <p className="flex items-center gap-2 text-body-sm text-muted mb-3">
            {percentOfBudget > 100 && <StatusDot status="danger" />}
            <span>
              {percentOfBudget}% of the <Money amount={budgetTarget} tone="muted" /> budget
              {percentOfBudget > 100 && <span className="text-danger font-semibold"> · over</span>}
            </span>
          </p>
        )}

        {isCurrent && (
          <div className="mb-3 pb-3 border-b border-border">
            <Readout
              label="Safe to spend"
              value={safeToSpendThisMonth}
              tone={safeToSpendThisMonth < 0 ? 'danger' : 'default'}
            />
            {percentOfBudget != null && (
              <div className="mt-2 space-y-1.5">
                <ProgressBar
                  value={percentOfBudget}
                  tone={percentOfBudget >= 100 ? 'danger' : pace && !pace.onTrack ? 'warn' : 'accent'}
                  label="Share of this month's budget spent"
                />
                <p className="type-data text-muted">
                  {percentOfBudget}% of <Money amount={budgetTarget} kobo={false} tone="muted" className="font-normal" />
                </p>
              </div>
            )}
            {percentOfBudget >= 100 && (
              <p className="flex items-center gap-2 mt-2 text-body-sm text-danger">
                <StatusDot status="danger" />
                <span>
                  <Money amount={thisMonthSpent - budgetTarget} tone="danger" /> over budget
                </span>
              </p>
            )}
            {pace && !pace.onTrack && percentOfBudget < 100 && (
              <p className="flex items-center gap-2 mt-2 text-body-sm text-warn">
                <StatusDot status="warn" />
                <span>
                  <Money amount={pace.aheadBy} tone="warn" /> ahead of pace for today
                </span>
              </p>
            )}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <Stat label="Income" value={<Money amount={thisMonthIncome} kobo={false} tone={thisMonthIncome > 0 ? 'positive' : 'default'} />} />
          <Stat label="Spent" value={<Money amount={thisMonthSpent} kobo={false} />} />
          <Stat
            label={isCurrent ? 'Liquid' : 'Net'}
            value={
              <Money
                amount={isCurrent ? thisMonthRemaining : thisMonthIncome - thisMonthSpent}
                kobo={false}
                tone={!isCurrent && thisMonthIncome - thisMonthSpent < 0 ? 'danger' : 'default'}
              />
            }
          />
        </div>

        {(monthSummary.movedAside > 0 || (isCurrent && monthRunway?.daysOfRunway != null)) && (
          <div className="space-y-1 mt-3 pt-3 border-t border-border">
            {monthSummary.movedAside > 0 && (
              <p className="text-body-sm text-muted">
                Moved to savings / cash: <Money amount={monthSummary.movedAside} className="text-foreground" />
              </p>
            )}
            {isCurrent && monthRunway?.daysOfRunway != null && (
              <p className="text-body-sm text-muted">
                At <Money amount={monthRunway.dailyBurn} tone="muted" />/day, liquid lasts{' '}
                <span className="text-foreground font-semibold">
                  {monthRunway.capped ? '90+' : monthRunway.daysOfRunway} days
                </span>
              </p>
            )}
          </div>
        )}
      </Panel>

      {/* Month in review */}
      <MonthRecap sentences={recapSentences} />

      {/* Category Breakdown */}
      <CategoryBreakdown
        byCategory={monthSummary.byCategory}
        budgetByCategory={budgetByCategory}
        averageByCategory={averageByCategory}
      />

      {/* Last 5 Transactions */}
      <Panel
        label="Last 5 transactions"
        flush
        action={
          <Button size="sm" variant="ghost" to="/transactions">
            See all
          </Button>
        }
      >
        {last5Transactions.length === 0 ? (
          <EmptyState
            title="No transactions yet"
            message="Log one to start seeing your spending here"
            actionLabel="Log a transaction"
            onAction={() => openQuickLog('debit')}
          />
        ) : (
          <ListRows>
            {last5Transactions.map((t) => {
              const isCredit = t.type === 'credit'
              return (
                <ListRow
                  key={t.id}
                  leading={<CategoryMark category={t.category} />}
                  title={t.description || t.category}
                  subtitle={`${t.category} · ${formatDate(t.transaction_date)}`}
                  meta={<Provenance source={t.source} at={t.transaction_time} />}
                  trailing={
                    <Money
                      amount={isCredit ? Number(t.amount) : -Number(t.amount)}
                      sign={isCredit}
                      tone={isCredit ? 'positive' : 'default'}
                    />
                  }
                />
              )
            })}
          </ListRows>
        )}
      </Panel>
    </div>
  )
}

/** A wallet's type as a glyph (the same mapping Daily HQ uses). */
const WALLET_GLYPH = { bank: 'bank', mobile: 'phone', cash: 'cash', savings: 'vault', investment: 'chart' }
