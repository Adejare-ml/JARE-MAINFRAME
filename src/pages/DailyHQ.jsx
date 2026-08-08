import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatNaira, formatDate } from '../lib/formatters'
import { getCategoryIcon } from '../lib/constants'
import { toast } from '../lib/toast'
import CashReconciliation from '../components/CashReconciliation'
import ErrorState from '../components/ui/ErrorState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { summarizeMonth } from '../lib/summary'
import {
  TRANSACTION_LIST_COLUMNS,
  TRANSACTION_SUMMARY_COLUMNS,
  startOfMonth,
  toDateOnly,
} from '../lib/queries'

export default function DailyHQ() {
  const [wallets, setWallets] = useState([])
  const [transactions, setTransactions] = useState([])
  const [monthTransactions, setMonthTransactions] = useState([])
  const [priorities, setPriorities] = useState(['', '', ''])
  const [unreviewedCount, setUnreviewedCount] = useState(0)
  const [warnThreshold, setWarnThreshold] = useState(10000)
  // Default until the user sets one in Settings; the bar hides at 0.
  const [budgetTarget, setBudgetTarget] = useState(85000)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [savingPriorities, setSavingPriorities] = useState(false)

  // Local date: the UTC form flips at 1am Lagos, which made this page load and
  // save *yesterday's* priorities during that hour.
  const todayDate = toDateOnly(new Date())
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
      const [walletsRes, recentRes, countRes, settingsRes, monthRes, goalsRes] =
        await Promise.all([
          supabase.from('wallets').select('*'),
          supabase
            .from('transactions')
            .select(TRANSACTION_LIST_COLUMNS)
            .order('transaction_date', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(3),
          supabase
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .or('reviewed.eq.false,category.eq.Uncategorized'),
          supabase
            .from('user_settings')
            .select('key, value')
            .in('key', ['low_balance_threshold', 'monthly_budget_target']),
          supabase
            .from('transactions')
            .select(TRANSACTION_SUMMARY_COLUMNS)
            .gte('transaction_date', startOfMonth()),
          supabase
            .from('goals')
            .select('*')
            .eq('period', 'daily')
            .eq('target_date', todayDate)
            .order('created_at', { ascending: true }),
        ])

      const firstError =
        walletsRes.error || recentRes.error || countRes.error ||
        settingsRes.error || monthRes.error || goalsRes.error
      if (firstError) throw firstError

      setWallets(walletsRes.data || [])
      setTransactions(recentRes.data || [])
      setUnreviewedCount(countRes.count || 0)
      setMonthTransactions(monthRes.data || [])

      for (const row of settingsRes.data || []) {
        const parsed = parseFloat(row.value)
        if (isNaN(parsed) || parsed < 0) continue
        if (row.key === 'low_balance_threshold') setWarnThreshold(parsed)
        if (row.key === 'monthly_budget_target') setBudgetTarget(parsed)
      }

      if (goalsRes.data && goalsRes.data.length > 0) {
        const loaded = ['', '', '']
        goalsRes.data.slice(0, 3).forEach((g, idx) => {
          loaded[idx] = g.title || ''
        })
        setPriorities(loaded)
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

  // This page runs five queries per refresh, so an undebounced subscription
  // meant a sync inserting 40 rows fired 200 round trips to render the same
  // three transactions.
  useRealtimeRefresh(['wallets', 'transactions'], fetchDailyData, { channelPrefix: 'hq' })

  const handleSavePriorities = async (e) => {
    e.preventDefault()
    setSavingPriorities(true)
    try {
      await supabase
        .from('goals')
        .delete()
        .eq('period', 'daily')
        .eq('target_date', todayDate)

      const goalsToInsert = priorities
        .filter(p => p.trim() !== '')
        .map(p => ({
          title: p.trim(),
          period: 'daily',
          target_date: todayDate,
          completed: false,
        }))

      if (goalsToInsert.length > 0) {
        const { error } = await supabase.from('goals').insert(goalsToInsert)
        if (error) throw error
      }

      toast.success('Priorities saved ✓')
    } catch (err) {
      console.error('Error saving priorities:', err)
      toast.error('Failed to save priorities')
    } finally {
      setSavingPriorities(false)
    }
  }

  const handlePriorityChange = (index, value) => {
    const updated = [...priorities]
    updated[index] = value
    setPriorities(updated)
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

  // Monthly Spending Progress. The old version summed the 3-row "recent"
  // query -- the headline card was three transactions divided by a hardcoded
  // 85000. Now: the real month query through the same tested math Budget uses,
  // transfers excluded, against a target set in Settings.
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
      <div>
        <p className="text-xs font-semibold text-muted tracking-wider uppercase mb-1">
          {fullDateStr}
        </p>
        <h1 className="text-2xl md:text-3xl font-extrabold text-white">
          {greeting}, Adejare 👋
        </h1>
      </div>

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
                {w.account_last4 && <span className="text-muted/40 font-mono">••{w.account_last4}</span>}
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

        {unreviewedCount === 0 && lowWallets.length === 0 ? (
          <div className="flex items-center gap-2 text-accent text-sm font-medium pt-1">
            <span>✅</span> All clear! No items require review.
          </div>
        ) : (
          <div className="space-y-2">
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
      <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
          Today's Priorities
        </h2>

        <form onSubmit={handleSavePriorities} className="space-y-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-3">
              <span className="text-xs font-bold text-accent w-4 text-center">{index + 1}.</span>
              <input
                type="text"
                value={priorities[index]}
                onChange={(e) => handlePriorityChange(index, e.target.value)}
                placeholder={`Priority #${index + 1}...`}
                className="flex-1 px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/40 focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>
          ))}

          <button
            type="submit"
            disabled={savingPriorities}
            className="w-full py-3.5 bg-accent hover:bg-accent/90 text-black font-bold text-sm rounded-xl transition-all shadow-md shadow-accent/20 min-h-[48px] disabled:opacity-50"
          >
            {savingPriorities ? 'Saving...' : 'Save Priorities ✓'}
          </button>
        </form>
      </section>

      {/* RECENT TRANSACTIONS */}
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

    </div>
  )
}
