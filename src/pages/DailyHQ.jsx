import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatNaira, formatDate } from '../lib/formatters'
import { getCategoryIcon } from '../lib/constants'
import { toast } from '../lib/toast'
import CashReconciliation from '../components/CashReconciliation'

export default function DailyHQ() {
  const [wallets, setWallets] = useState([])
  const [transactions, setTransactions] = useState([])
  const [priorities, setPriorities] = useState(['', '', ''])
  const [unreviewedCount, setUnreviewedCount] = useState(0)
  const [warnThreshold, setWarnThreshold] = useState(10000)
  const [loading, setLoading] = useState(true)
  const [savingPriorities, setSavingPriorities] = useState(false)

  const todayDate = new Date().toISOString().split('T')[0]
  const fullDateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })

  const currentHour = new Date().getHours()
  const greeting = currentHour < 12 ? 'Good morning' : currentHour < 17 ? 'Good afternoon' : 'Good evening'

  const fetchDailyData = async () => {
    try {
      // 1. Fetch Wallets
      const { data: wData } = await supabase.from('wallets').select('*')
      setWallets(wData || [])

      // 2. Fetch Recent Transactions (last 3)
      const { data: tData } = await supabase
        .from('transactions')
        .select('*')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(3)
      setTransactions(tData || [])

      // 3. Count Unreviewed Transactions
      const { count } = await supabase
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .or('reviewed.eq.false,category.eq.Uncategorized')
      setUnreviewedCount(count || 0)

      // 4. Fetch Low Balance Threshold from user_settings
      const { data: setData } = await supabase
        .from('user_settings')
        .select('*')
        .eq('key', 'low_balance_threshold')
        .maybeSingle()

      if (setData && setData.value) {
        const parsed = parseFloat(setData.value)
        if (!isNaN(parsed) && parsed >= 0) {
          setWarnThreshold(parsed)
        }
      }

      // 5. Fetch Today's Priorities from `goals` table
      const { data: gData } = await supabase
        .from('goals')
        .select('*')
        .eq('period', 'daily')
        .eq('target_date', todayDate)
        .order('created_at', { ascending: true })

      if (gData && gData.length > 0) {
        const loaded = ['', '', '']
        gData.slice(0, 3).forEach((g, idx) => {
          loaded[idx] = g.title || ''
        })
        setPriorities(loaded)
      }
    } catch (err) {
      console.error('Error fetching Daily HQ data:', err)
      toast.error('Failed to update dashboard')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDailyData()

    // Realtime listener
    const walletSub = supabase
      .channel('realtime:hq_wallets')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wallets' }, () => {
        fetchDailyData()
      })
      .subscribe()

    const txnSub = supabase
      .channel('realtime:hq_txns')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
        fetchDailyData()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(walletSub)
      supabase.removeChannel(txnSub)
    }
  }, [])

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

  // Calculate Wallet Totals
  const totalBalance = wallets.reduce((sum, w) => sum + Number(w.balance || 0), 0)
  const gtWallet = wallets.find(w => w.name.toLowerCase().includes('gt'))
  const opayWallet = wallets.find(w => w.name.toLowerCase().includes('opay'))
  const cashWallet = wallets.find(w => w.name.toLowerCase().includes('cash'))

  // Check Low Balance Alerts against dynamic threshold
  const lowWallets = wallets.filter(w => Number(w.balance || 0) < warnThreshold)

  // Monthly Spending Progress
  const totalSpent = transactions
    .filter(t => t.type === 'debit')
    .reduce((sum, t) => sum + Number(t.amount || 0), 0)
  const budgetTarget = 85000 // Standard monthly budget benchmark
  const percentSpent = Math.min(Math.round((totalSpent / budgetTarget) * 100), 100)

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

      {/* WALLET SNAPSHOT */}
      <section className="bg-card rounded-3xl p-6 border border-white/10 relative overflow-hidden shadow-xl">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">
          Wallet Snapshot
        </p>
        <p className="text-3xl sm:text-4xl font-extrabold text-white mb-4">
          Total: {formatNaira(totalBalance)}
        </p>

        <div className="grid grid-cols-3 gap-2 pt-3 border-t border-white/5 text-center sm:text-left">
          <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
            <p className="text-[11px] text-muted flex items-center gap-1">
              <span>🏦</span> GTBank
            </p>
            <p className="text-sm font-bold text-white mt-1">
              {formatNaira(gtWallet?.balance || 0)}
            </p>
          </div>

          <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
            <p className="text-[11px] text-muted flex items-center gap-1">
              <span>📱</span> OPay
            </p>
            <p className="text-sm font-bold text-white mt-1">
              {formatNaira(opayWallet?.balance || 0)}
            </p>
          </div>

          <div className="bg-background/40 p-3 rounded-2xl border border-white/5">
            <p className="text-[11px] text-muted flex items-center gap-1">
              <span>💵</span> Cash
            </p>
            <p className="text-sm font-bold text-white mt-1">
              {formatNaira(cashWallet?.balance || 0)}
            </p>
          </div>
        </div>
      </section>

      {/* THIS MONTH PROGRESS */}
      <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3">
        <div className="flex items-center justify-between text-xs font-semibold">
          <span className="text-muted uppercase tracking-wider">This Month</span>
          <span className="text-accent">{percentSpent}% of budget</span>
        </div>

        {/* Progress Bar */}
        <div className="h-3 bg-background rounded-full overflow-hidden border border-white/5">
          <div
            className="h-full bg-accent rounded-full transition-all duration-500"
            style={{ width: `${percentSpent}%` }}
          />
        </div>

        <p className="text-xs text-muted text-right">
          {formatNaira(totalSpent)} spent of {formatNaira(budgetTarget)}
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
