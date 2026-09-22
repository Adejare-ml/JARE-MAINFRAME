import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import WalletCard from '../components/ui/WalletCard'
import CategoryBreakdown from '../components/ui/CategoryBreakdown'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import NetWorthSparkline from '../components/ui/NetWorthSparkline'
import { BudgetSkeleton } from '../components/ui/PageSkeleton'
import { openQuickLog } from '../components/ui/QuickLog'
import { formatNaira, timeAgo, formatDate } from '../lib/formatters'
import { getCategoryIcon } from '../lib/constants'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import ProgressRing from '../components/ui/ProgressRing'
import { summarizeMonth, runway, safeToSpend, budgetPace, categoryAverages } from '../lib/summary'
import {
  transactionListColumns,
  transactionSummaryColumns,
  startOfMonth,
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

  const fetchWalletsAndData = useCallback(async () => {
    try {
      setPageError(null)
      const now = new Date()
      const averageWindowStart = startOfMonth(new Date(now.getFullYear(), now.getMonth() - AVERAGE_MONTHS, 1))

      const [walletsRes, monthRes, recentRes, settingsRes, netWorthRes, categoryBudgetsRes, averageWindowRes] = await Promise.all([
        supabase.from('wallets').select('*').order('name'),
        // Totals are keyed on transaction_date -- the date the bank says the
        // money moved -- not created_at, which is when the sync happened. A
        // backfill inserts last month's transactions today, and keying on
        // created_at counted every one of them against this month.
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionSummaryColumns())
            .gte('transaction_date', startOfMonth()),
        ),
        excludeVoided(
          supabase
            .from('transactions')
            .select(transactionListColumns())
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
            .lt('transaction_date', startOfMonth()),
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
  }, [])

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
      <div className="p-4 md:p-8 max-w-2xl mx-auto">
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
      <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6 text-center">
        <span className="text-5xl block" aria-hidden="true">👛</span>
        <div>
          <h1 className="text-2xl font-bold text-white mb-2">No wallets yet</h1>
          <p className="text-muted text-sm max-w-sm mx-auto">
            Add your bank accounts, Opay and cash in Settings — including the alert sender
            address so transactions sync automatically.
          </p>
        </div>
        <Link
          to="/settings"
          className="inline-block px-6 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] leading-6"
        >
          Set up wallets →
        </Link>
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
  const liquidWalletIds = new Set(liquidWallets.map(w => w.id))
  const monthSummary = summarizeMonth(monthTransactions, liquidWalletIds)

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

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Budget 💰</h1>
          <p className="text-muted text-sm mt-0.5">
            <Link to="/repairs" className="text-accent hover:underline">
              Repairs & maintenance →
            </Link>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => openQuickLog('debit')}
            className="bg-card hover:bg-card/80 border border-white/10 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors min-h-[48px]"
          >
            + Log Transaction
          </button>
          <button
            onClick={() => openQuickLog('transfer')}
            className="bg-card hover:bg-card/80 border border-white/10 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors min-h-[48px]"
          >
            ⇄ Transfer
          </button>
          <button
            onClick={() => openQuickLog('credit')}
            className="bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 px-4 py-2 rounded-xl text-sm font-medium transition-colors min-h-[48px]"
          >
            + Income
          </button>
        </div>
      </div>

      {/* ── Layered Net Worth Card ── */}
      <div className="bg-card rounded-3xl p-6 md:p-8 border border-white/5 relative overflow-hidden group">
        <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
          <span className="text-8xl">💰</span>
        </div>
        <p className="text-muted font-medium mb-2">TOTAL NET WORTH</p>
        <h2 className="text-4xl md:text-5xl font-bold text-white mb-4 money">
          {formatNaira(totalNetWorth)}
        </h2>

        <div className="mb-4">
          <NetWorthSparkline snapshots={netWorthHistory} />
        </div>

        {/* Layered breakdown */}
        {hasSavingsOrInvestments && (
          <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/5">
            <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1">💳 Liquid</p>
              <p className="text-sm font-bold text-white money">{formatNaira(liquidBalance)}</p>
            </div>
            <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1">🐖 Savings</p>
              <p className="text-sm font-bold text-blue-400 money">{formatNaira(savingsBalance)}</p>
            </div>
            <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1">📈 Invested</p>
              <p className="text-sm font-bold text-purple-400 money">{formatNaira(investmentBalance)}</p>
            </div>
          </div>
        )}

        <p className="text-xs text-muted mt-3">
          Last updated: {latestLastUpdated ? timeAgo(latestLastUpdated) : 'Just now'}
        </p>
      </div>

      {/* Wallets List */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {activeWallets.map((wallet) => (
          <WalletCard
            key={wallet.id}
            name={wallet.name}
            type={wallet.type}
            balance={wallet.balance}
            color={wallet.color}
          />
        ))}
      </div>

      {/* This Month Summary Card */}
      <div className="bg-card rounded-3xl p-6 border border-white/5">
        <h3 className="text-lg font-bold text-white mb-6">THIS MONTH</h3>

        <div className="flex items-center gap-5 mb-6">
          {percentOfBudget != null && (
            <ProgressRing
              value={percentOfBudget / 100}
              size={72}
              strokeWidth={7}
              color={percentOfBudget >= 100 ? '#ef4444' : pace && !pace.onTrack ? '#f59e0b' : 'var(--color-accent)'}
            >
              <span className="text-xs font-bold text-white">{percentOfBudget}%</span>
            </ProgressRing>
          )}
          <div>
            <p className="text-xs text-muted mb-1">Safe to spend</p>
            <p className="text-3xl font-bold text-white money">{formatNaira(safeToSpendThisMonth)}</p>
            {percentOfBudget >= 100 && (
              <p className="text-xs text-red-400 font-semibold mt-1">
                <span className="money">{formatNaira(thisMonthSpent - budgetTarget)}</span> over budget
              </p>
            )}
            {pace && !pace.onTrack && percentOfBudget < 100 && (
              <p className="text-xs text-amber-400 font-semibold mt-1">
                <span className="money">{formatNaira(pace.aheadBy)}</span> ahead of pace for today
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-muted mb-1">Income</p>
            <p className="text-lg font-bold text-accent money">{formatNaira(thisMonthIncome)}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Spent</p>
            {/* red-400, not red-500: 500 measured only 4.6:1 against this
                card background, a thin margin above the 4.5:1 floor for
                text this size; 400 measures 6.3:1. */}
            <p className="text-lg font-bold text-red-400 money">{formatNaira(thisMonthSpent)}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Liquid Balance</p>
            <p className="text-lg font-bold text-white money">{formatNaira(thisMonthRemaining)}</p>
          </div>
        </div>

        {(monthSummary.movedAside > 0 || monthRunway?.daysOfRunway != null) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-5 pt-4 border-t border-white/5">
            {monthSummary.movedAside > 0 && (
              <p className="text-xs text-muted">
                Moved to savings / cash:{' '}
                <span className="text-blue-400 font-semibold money">{formatNaira(monthSummary.movedAside)}</span>
              </p>
            )}
            {monthRunway?.daysOfRunway != null && (
              <p className="text-xs text-muted">
                At <span className="money">{formatNaira(monthRunway.dailyBurn)}</span>/day, liquid lasts{' '}
                <span className="text-white font-semibold">
                  {monthRunway.capped ? '90+' : monthRunway.daysOfRunway} days
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* Category Breakdown */}
      <CategoryBreakdown
        byCategory={monthSummary.byCategory}
        budgetByCategory={budgetByCategory}
        averageByCategory={averageByCategory}
      />

      {/* Last 5 Transactions */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">LAST 5 TRANSACTIONS</h3>
          <Link to="/transactions" className="text-sm text-accent hover:underline min-h-[48px] flex items-center">
            See all →
          </Link>
        </div>
        
        {last5Transactions.length === 0 ? (
          <div className="bg-card rounded-2xl border border-white/5">
            <EmptyState
              icon="💳"
              title="No transactions yet"
              message="Log one to start seeing your spending here"
              actionLabel="Log a transaction"
              onAction={() => openQuickLog('debit')}
            />
          </div>
        ) : (
          <div className="bg-card rounded-2xl border border-white/5 overflow-hidden">
            {last5Transactions.map((t, idx) => (
              <div 
                key={t.id} 
                className={`flex items-center justify-between p-4 ${
                  idx !== last5Transactions.length - 1 ? 'border-b border-white/5' : ''
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center text-xl bg-gray-500/20`}>
                    <span className="opacity-80">{getCategoryIcon(t.category)}</span>
                  </div>
                  <div>
                    <p className="text-white font-medium">{t.description || t.category}</p>
                    <p className="text-xs text-muted">{formatDate(t.transaction_date)}</p>
                  </div>
                </div>
                <div className={`font-bold money ${t.type === 'credit' ? 'text-accent' : 'text-white'}`}>
                  {t.type === 'credit' ? '+' : '-'}{formatNaira(t.amount)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
