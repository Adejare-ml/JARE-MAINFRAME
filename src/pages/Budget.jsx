import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import WalletCard from '../components/ui/WalletCard'
import CategoryBreakdown from '../components/ui/CategoryBreakdown'
import ErrorState from '../components/ui/ErrorState'
import { openQuickLog } from '../components/ui/QuickLog'
import { formatNaira, timeAgo, formatDate } from '../lib/formatters'
import { getCategoryIcon } from '../lib/constants'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { summarizeMonth, runway } from '../lib/summary'
import {
  transactionListColumns,
  transactionSummaryColumns,
  startOfMonth,
  excludeVoided,
} from '../lib/queries'

export default function Budget() {
  const [wallets, setWallets] = useState([])
  // Two scoped queries rather than one unbounded fetch: this page only ever
  // shows the current month's totals and the five most recent rows, so pulling
  // the whole table (with email bodies attached) was paying for the entire
  // ledger to render eight numbers.
  const [monthTransactions, setMonthTransactions] = useState([])
  const [recentTransactions, setRecentTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)

  const fetchWalletsAndData = useCallback(async () => {
    try {
      setPageError(null)
      const [walletsRes, monthRes, recentRes] = await Promise.all([
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
      ])

      if (walletsRes.error) throw walletsRes.error
      if (monthRes.error) throw monthRes.error
      if (recentRes.error) throw recentRes.error

      setWallets(walletsRes.data || [])
      setMonthTransactions(monthRes.data || [])
      setRecentTransactions(recentRes.data || [])
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
    return (
      <div className="p-4 md:p-8 animate-pulse space-y-6">
        <div className="h-10 bg-white/5 rounded w-1/3"></div>
        <div className="h-32 bg-white/5 rounded-2xl"></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="h-24 bg-white/5 rounded-2xl"></div>
          <div className="h-24 bg-white/5 rounded-2xl"></div>
          <div className="h-24 bg-white/5 rounded-2xl"></div>
        </div>
      </div>
    )
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

  const thisMonthIncome = monthSummary.income
  const thisMonthSpent = monthSummary.spent
  const thisMonthRemaining = liquidBalance
  const monthRunway = runway(liquidBalance, thisMonthSpent, new Date().getDate())

  const last5Transactions = recentTransactions

  const hasSavingsOrInvestments = savingsWallets.length > 0 || investmentWallets.length > 0

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-3xl font-bold text-white tracking-tight">Budget 💰</h1>
        <div className="flex gap-2">
          <button
            onClick={() => openQuickLog('debit')}
            className="bg-card hover:bg-card/80 border border-white/10 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors min-h-[48px]"
          >
            + Log Transaction
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
        <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">
          {formatNaira(totalNetWorth)}
        </h2>

        {/* Layered breakdown */}
        {hasSavingsOrInvestments && (
          <div className="grid grid-cols-3 gap-3 pt-4 border-t border-white/5">
            <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1">💳 Liquid</p>
              <p className="text-sm font-bold text-white">{formatNaira(liquidBalance)}</p>
            </div>
            <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1">🐖 Savings</p>
              <p className="text-sm font-bold text-blue-400">{formatNaira(savingsBalance)}</p>
            </div>
            <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
              <p className="text-[10px] text-muted uppercase tracking-wider mb-1">📈 Invested</p>
              <p className="text-sm font-bold text-purple-400">{formatNaira(investmentBalance)}</p>
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
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-muted mb-1">Income</p>
            <p className="text-lg font-bold text-accent">{formatNaira(thisMonthIncome)}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Spent</p>
            <p className="text-lg font-bold text-red-500">{formatNaira(thisMonthSpent)}</p>
          </div>
          <div>
            <p className="text-xs text-muted mb-1">Liquid Balance</p>
            <p className="text-lg font-bold text-white">{formatNaira(thisMonthRemaining)}</p>
          </div>
        </div>

        {(monthSummary.movedAside > 0 || monthRunway?.daysOfRunway != null) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 mt-5 pt-4 border-t border-white/5">
            {monthSummary.movedAside > 0 && (
              <p className="text-xs text-muted">
                Moved to savings / cash:{' '}
                <span className="text-blue-400 font-semibold">{formatNaira(monthSummary.movedAside)}</span>
              </p>
            )}
            {monthRunway?.daysOfRunway != null && (
              <p className="text-xs text-muted">
                At {formatNaira(monthRunway.dailyBurn)}/day, liquid lasts{' '}
                <span className="text-white font-semibold">
                  {monthRunway.capped ? '90+' : monthRunway.daysOfRunway} days
                </span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* Category Breakdown */}
      <CategoryBreakdown byCategory={monthSummary.byCategory} />

      {/* Last 5 Transactions */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-white">LAST 5 TRANSACTIONS</h3>
          <Link to="/transactions" className="text-sm text-accent hover:underline min-h-[48px] flex items-center">
            See all →
          </Link>
        </div>
        
        {last5Transactions.length === 0 ? (
          <div className="bg-card rounded-2xl p-8 text-center border border-white/5">
            <p className="text-muted">No transactions found.</p>
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
                <div className={`font-bold ${t.type === 'credit' ? 'text-accent' : 'text-white'}`}>
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
