import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { formatNaira, formatDate, formatTime } from '../lib/formatters'
import { CATEGORIES, getCategoryIcon } from '../lib/constants'
import { toast } from '../lib/toast'

export default function Transactions() {
  const [transactions, setTransactions] = useState([])
  const [wallets, setWallets] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('All')
  const [expandedId, setExpandedId] = useState(null)

  // Edit state for expanded row
  const [editCategory, setEditCategory] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editWantNeed, setEditWantNeed] = useState(null)
  const [updating, setUpdating] = useState(false)

  const fetchData = async () => {
    try {
      const { data: wData } = await supabase.from('wallets').select('*')
      setWallets(wData || [])

      const { data: tData, error } = await supabase
        .from('transactions')
        .select('*')
        .order('transaction_date', { ascending: false })
        .order('created_at', { ascending: false })

      if (error) throw error
      setTransactions(tData || [])
    } catch (err) {
      console.error('Error fetching transactions:', err)
      toast.error('Failed to load transactions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()

    const txnSub = supabase
      .channel('realtime:transactions_page')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, () => {
        fetchData()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(txnSub)
    }
  }, [])

  const filterOptions = [
    'All',
    'Review',
    'This Week',
    'This Month',
    'GTBank',
    'OPay',
    'Cash',
    'Needs',
    'Wants',
    'Uncategorized',
  ]

  const getWalletName = (walletId, source) => {
    const found = wallets.find(w => w.id === walletId)
    if (found) return found.name
    if (source === 'gtbank') return 'GTBank'
    if (source === 'opay') return 'OPay'
    return 'Manual'
  }

  const now = new Date()
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  const filteredTransactions = transactions.filter(t => {
    const tDate = new Date(t.transaction_date || t.created_at)
    
    if (filter === 'All') return true
    if (filter === 'Review') return t.reviewed === false || t.category === 'Uncategorized'
    if (filter === 'This Week') return tDate >= oneWeekAgo
    if (filter === 'This Month') return tDate >= firstDayOfMonth
    if (filter === 'GTBank') {
      const wName = getWalletName(t.wallet_id, t.source).toLowerCase()
      return wName.includes('gt') || t.source === 'gtbank'
    }
    if (filter === 'OPay') {
      const wName = getWalletName(t.wallet_id, t.source).toLowerCase()
      return wName.includes('opay') || t.source === 'opay'
    }
    if (filter === 'Cash') {
      const wName = getWalletName(t.wallet_id, t.source).toLowerCase()
      return wName.includes('cash')
    }
    if (filter === 'Needs') return t.want_or_need === 'need'
    if (filter === 'Wants') return t.want_or_need === 'want'
    if (filter === 'Uncategorized') return t.category === 'Uncategorized'
    return true
  })

  const unreviewedCount = transactions.filter(t => t.reviewed === false || t.category === 'Uncategorized').length

  const handleRowClick = (txn) => {
    if (expandedId === txn.id) {
      setExpandedId(null)
    } else {
      setExpandedId(txn.id)
      setEditCategory(txn.category || 'Uncategorized')
      setEditNote(txn.note || txn.description || '')
      setEditWantNeed(txn.want_or_need || null)
    }
  }

  const handleSaveChanges = async (txnId) => {
    setUpdating(true)
    try {
      const { error } = await supabase
        .from('transactions')
        .update({
          category: editCategory,
          note: editNote.trim() || null,
          description: editNote.trim() || editCategory,
          want_or_need: editWantNeed,
          reviewed: true,
        })
        .eq('id', txnId)

      if (error) throw error

      toast.success('Transaction updated ✓')
      setExpandedId(null)
      fetchData()
    } catch (err) {
      console.error('Error updating transaction:', err)
      toast.error('Failed to update transaction')
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 bg-white/5 rounded-xl w-48" />
        <div className="h-12 bg-card rounded-2xl border border-white/5" />
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map(n => (
            <div key={n} className="h-16 bg-card rounded-2xl border border-white/5" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white flex items-center gap-3">
            <span>Transactions</span>
            <span className="text-xs bg-white/10 px-3 py-1 rounded-full text-muted font-normal">
              {filteredTransactions.length}
            </span>
          </h1>
          <p className="text-muted text-sm mt-0.5">Filter, review, and categorize transactions</p>
        </div>
      </div>

      {/* Filter Chips Horizontal Scroll */}
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {filterOptions.map((opt) => {
          const isActive = filter === opt
          const isReview = opt === 'Review'
          return (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              className={`px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 min-h-[48px] ${
                isActive
                  ? 'bg-accent text-black font-bold shadow-md shadow-accent/20'
                  : 'bg-card text-muted hover:text-white border border-white/5'
              }`}
            >
              <span>{opt}</span>
              {isReview && unreviewedCount > 0 && (
                <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-extrabold ${
                  isActive ? 'bg-black text-accent' : 'bg-orange-500 text-black'
                }`}>
                  {unreviewedCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Transaction List */}
      {filteredTransactions.length === 0 ? (
        <div className="bg-card rounded-3xl p-12 border border-white/5 text-center space-y-3">
          <span className="text-4xl">💳</span>
          <p className="text-base font-bold text-white">No transactions found</p>
          <p className="text-xs text-muted">Try selecting a different filter or log a transaction</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredTransactions.map((t) => {
            const isExpanded = expandedId === t.id
            const isCredit = t.type === 'credit'
            const icon = getCategoryIcon(t.category)
            const walletName = getWalletName(t.wallet_id, t.source)
            const isUnreviewed = t.reviewed === false || t.category === 'Uncategorized'

            return (
              <div
                key={t.id}
                className={`bg-card rounded-2xl border transition-all overflow-hidden ${
                  isExpanded ? 'border-accent bg-card/90 shadow-xl' : 'border-white/5 hover:border-white/10'
                }`}
              >
                {/* Main Row */}
                <div
                  onClick={() => handleRowClick(t)}
                  className="p-4 flex items-center justify-between cursor-pointer min-h-[56px]"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="relative">
                      <div className="w-11 h-11 rounded-2xl bg-background flex items-center justify-center text-xl border border-white/5">
                        {icon}
                      </div>
                      {isUnreviewed && (
                        <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-500 rounded-full border-2 border-card" />
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-bold text-white truncate">
                          {t.description || t.category}
                        </p>
                        {t.want_or_need && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                            t.want_or_need === 'need' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' :
                            t.want_or_need === 'want' ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' :
                            'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                          }`}>
                            {t.want_or_need}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted mt-0.5">
                        {walletName} · {formatDate(t.transaction_date)} {t.transaction_time ? `at ${formatTime(t.transaction_time)}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="text-right ml-3 shrink-0">
                    <span className={`text-base font-extrabold ${isCredit ? 'text-accent' : 'text-white'}`}>
                      {isCredit ? '+' : '-'}{formatNaira(t.amount)}
                    </span>
                    <p className="text-[10px] text-muted capitalize mt-0.5">{t.source || 'manual'}</p>
                  </div>
                </div>

                {/* Expanded Details & Editor */}
                {isExpanded && (
                  <div className="px-4 pb-5 pt-2 border-t border-white/5 space-y-4 bg-background/50 animate-fade-in">
                    
                    {/* Category Selector */}
                    <div>
                      <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                        Category
                      </label>
                      <select
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
                      >
                        {Object.values(CATEGORIES).flat().map(c => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>

                    {/* Note Field */}
                    <div>
                      <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                        Note / Description
                      </label>
                      <input
                        type="text"
                        value={editNote}
                        onChange={(e) => setEditNote(e.target.value)}
                        placeholder="Add a note..."
                        className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
                      />
                    </div>

                    {/* Want or Need Selector */}
                    <div>
                      <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                        Tag (Want / Need)
                      </label>
                      <div className="grid grid-cols-4 gap-2">
                        {['need', 'want', 'obligation', 'emergency'].map(tag => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => setEditWantNeed(editWantNeed === tag ? null : tag)}
                            className={`py-2 px-1 rounded-xl text-[11px] font-bold uppercase tracking-wider border transition-all min-h-[48px] ${
                              editWantNeed === tag
                                ? 'bg-accent/20 border-accent text-accent'
                                : 'bg-card border-white/5 text-muted hover:text-white'
                            }`}
                          >
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Save Button */}
                    <div className="flex items-center gap-2 pt-2">
                      <button
                        onClick={() => handleSaveChanges(t.id)}
                        disabled={updating}
                        className="flex-1 py-3 bg-accent text-black font-bold text-sm rounded-xl hover:bg-accent/90 transition-all min-h-[48px] flex items-center justify-center gap-2"
                      >
                        {updating ? 'Saving...' : 'Save & Mark Reviewed ✓'}
                      </button>
                      <button
                        onClick={() => setExpandedId(null)}
                        className="px-4 py-3 bg-white/5 text-muted hover:text-white text-sm font-semibold rounded-xl min-h-[48px]"
                      >
                        Cancel
                      </button>
                    </div>

                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
