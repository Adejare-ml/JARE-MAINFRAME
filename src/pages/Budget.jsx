import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import WalletCard from '../components/ui/WalletCard'
import { formatNaira, timeAgo, formatDate } from '../lib/formatters'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  TRANSACTION_LIST_COLUMNS,
  TRANSACTION_SUMMARY_COLUMNS,
  startOfMonth,
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
  const [setupBalances, setSetupBalances] = useState({
    GTBank: '',
    OPay: '',
    Cash: ''
  })
  
  const [quickLogMode, setQuickLogMode] = useState(null) // 'debit' or 'credit'

  const fetchWalletsAndData = useCallback(async () => {
    try {
      const [walletsRes, monthRes, recentRes] = await Promise.all([
        supabase.from('wallets').select('*').order('name'),
        // Totals are keyed on transaction_date -- the date the bank says the
        // money moved -- not created_at, which is when the sync happened. A
        // backfill inserts last month's transactions today, and keying on
        // created_at counted every one of them against this month.
        supabase
          .from('transactions')
          .select(TRANSACTION_SUMMARY_COLUMNS)
          .gte('transaction_date', startOfMonth()),
        supabase
          .from('transactions')
          .select(TRANSACTION_LIST_COLUMNS)
          .order('transaction_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(5),
      ])

      if (walletsRes.error) throw walletsRes.error
      if (monthRes.error) throw monthRes.error
      if (recentRes.error) throw recentRes.error

      setWallets(walletsRes.data || [])
      setMonthTransactions(monthRes.data || [])
      setRecentTransactions(recentRes.data || [])
    } catch (error) {
      console.error('Error fetching data:', error)
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

  const handleActivate = async (name, type) => {
    const balance = parseFloat(setupBalances[name]) || 0
    try {
      const { error } = await supabase
        .from('wallets')
        .insert([{ name, type, balance, currency: 'NGN' }])
      if (error) throw error
    } catch (error) {
      console.error('Error activating wallet:', error)
    }
  }

  const isWalletActivated = (name) => wallets.some((w) => w.name === name)

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

  // Setup Screen
  const allActivated = isWalletActivated('GTBank') && isWalletActivated('OPay') && isWalletActivated('Cash')
  if (wallets.length === 0 || !allActivated) {
    return (
      <div className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Set up your wallets</h1>
          <p className="text-muted text-sm">Enter your starting balances to activate your standard wallets.</p>
        </div>

        <div className="space-y-4">
          {[
            { name: 'GTBank', type: 'bank', label: 'GTBank' },
            { name: 'OPay', type: 'mobile', label: 'OPay' },
            { name: 'Cash', type: 'cash', label: 'Cash on Hand' }
          ].map((wallet) => {
            const activated = isWalletActivated(wallet.name)
            return (
              <div key={wallet.name} className="bg-card border border-white/5 p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="text-white font-medium">{wallet.label}</h3>
                  <p className="text-xs text-muted capitalize">{wallet.type}</p>
                </div>
                
                {activated ? (
                  <div className="text-accent font-medium bg-accent/10 px-4 py-2 rounded-lg text-center flex items-center justify-center min-h-[48px]">
                    Activated
                  </div>
                ) : (
                  <div className="flex gap-2 w-full md:w-auto">
                    <input
                      type="number"
                      placeholder="Opening balance"
                      className="bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm flex-1 md:w-32 focus:outline-none focus:border-accent min-h-[48px]"
                      value={setupBalances[wallet.name]}
                      onChange={(e) => setSetupBalances({ ...setupBalances, [wallet.name]: e.target.value })}
                    />
                    <button
                      onClick={() => handleActivate(wallet.name, wallet.type)}
                      className="bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors min-h-[48px] min-w-[48px]"
                    >
                      Activate
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
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

  // This Month summary — already scoped to the month by the query.
  // Savings and investment wallets are excluded so moving money into PiggyVest
  // doesn't read as spending.
  const liquidWalletIds = new Set(liquidWallets.map(w => w.id))

  const thisMonthIncome = monthTransactions
    .filter(t => t.type === 'credit' && (!t.wallet_id || liquidWalletIds.has(t.wallet_id)))
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)

  const thisMonthSpent = monthTransactions
    .filter(t => t.type === 'debit' && (!t.wallet_id || liquidWalletIds.has(t.wallet_id)))
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0)

  const thisMonthRemaining = liquidBalance

  const last5Transactions = recentTransactions

  const hasSavingsOrInvestments = savingsWallets.length > 0 || investmentWallets.length > 0

  return (
    <div className="p-4 md:p-8 space-y-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h1 className="text-3xl font-bold text-white tracking-tight">Budget 💰</h1>
        <div className="flex gap-2">
          <button 
            onClick={() => setQuickLogMode('debit')}
            className="bg-card hover:bg-card/80 border border-white/10 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors min-h-[48px]"
          >
            + Log Transaction
          </button>
          <button 
            onClick={() => setQuickLogMode('credit')}
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
      </div>

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
                    <span className="opacity-80">
                      {t.category === 'Food' ? '🍔' : 
                       t.category === 'Transport' ? '🚗' : 
                       t.category === 'Airtime & Data' ? '📱' : '📝'}
                    </span>
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

      {/* QuickLog Modal Placeholder */}
      {quickLogMode && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card p-6 rounded-3xl w-full max-w-md border border-white/10 relative">
            <button 
              onClick={() => setQuickLogMode(null)}
              className="absolute top-4 right-4 text-muted hover:text-white w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10"
            >
              ✕
            </button>
            <h2 className="text-xl font-bold text-white mb-4">
              {quickLogMode === 'credit' ? 'Log Income' : 'Log Transaction'}
            </h2>
            <p className="text-muted text-sm mb-4">
              QuickLog functionality will be integrated here.
            </p>
            <div className="flex justify-end">
              <button 
                onClick={() => setQuickLogMode(null)}
                className="bg-accent text-black font-bold px-4 py-2 rounded-xl min-h-[48px]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
