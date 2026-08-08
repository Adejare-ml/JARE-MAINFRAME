import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatNaira, formatDate, formatTime } from '../lib/formatters'
import { CATEGORIES, getCategoryIcon } from '../lib/constants'
import { toast } from '../lib/toast'
import ErrorState from '../components/ui/ErrorState'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  transactionListColumns,
  PAGE_SIZE,
  applyTransactionFilter,
  buildFilterOptions,
  NEEDS_REVIEW_FILTER,
  needsReview,
  excludeVoided,
} from '../lib/queries'
import { validateCorrection, isMissingFunctionError } from '../lib/corrections'

export default function Transactions() {
  const [transactions, setTransactions] = useState([])
  const [wallets, setWallets] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // Deep links from the Budget breakdown arrive as /transactions?category=Rent.
  const [searchParams] = useSearchParams()
  const initialCategory = searchParams.get('category')
  const [filter, setFilter] = useState(initialCategory ? `category:${initialCategory}` : 'All')
  const [expandedId, setExpandedId] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [unreviewedCount, setUnreviewedCount] = useState(0)
  const [pageError, setPageError] = useState(null)
  // How many rows are on screen, so a refetch can restore the same depth.
  // A ref rather than state: fetchData reads it without wanting to re-run.
  const loadedCountRef = useRef(0)

  // Edit state for expanded row
  const [editCategory, setEditCategory] = useState('')
  const [editNote, setEditNote] = useState('')
  const [editWantNeed, setEditWantNeed] = useState(null)
  // A parse can be wrong about more than its category. A flipped direction or a
  // mis-read amount used to be fixable only in the Supabase dashboard, and
  // re-syncing would not repair it either -- the upsert's ignoreDuplicates
  // discards the corrected second read.
  const [editType, setEditType] = useState('debit')
  const [editAmount, setEditAmount] = useState('')
  const [editDate, setEditDate] = useState('')
  const [updating, setUpdating] = useState(false)
  const [confirmVoidId, setConfirmVoidId] = useState(null)

  // Two pieces of state for one box: `search` is what the field shows, and
  // `activeSearch` is what has actually been sent. Without the split, every
  // keystroke re-runs the query and refetches every page on screen.
  const [search, setSearch] = useState('')
  const [activeSearch, setActiveSearch] = useState('')

  // Bulk selection. Deliberately a set of explicit ids and never "everything
  // matching the current filter": a mis-tap that recategorises 400 rows is not
  // undoable, and it would teach the corrections table the wrong lesson too.
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [bulkCategory, setBulkCategory] = useState('Uncategorized')

  useEffect(() => {
    const timer = setTimeout(() => setActiveSearch(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  /**
   * Fetch one page of transactions.
   *
   * Filtering runs in Postgres rather than over the fetched array. With
   * pagination, a client-side filter would only ever search the rows already
   * loaded, so "Uncategorized" would show whatever happened to be in the most
   * recent 50 rather than the actual answer.
   */
  /**
   * Fetch rows [from, from+size). Used both for the initial page and, on a
   * refetch, for every page currently on screen at once.
   */
  const fetchRange = useCallback(
    async (from, size, currentWallets) => {
      let query = excludeVoided(
        supabase.from('transactions').select(transactionListColumns()),
      )

      // The review queue is ordered by what a mistake costs, biggest first. A
      // mis-parsed ₦50,000 transfer is worth catching; a mis-categorised ₦150
      // airtime top-up is not worth scrolling for. Everything else reads as a
      // ledger, so it stays newest-first.
      if (filter === 'Review') {
        query = query
          .order('amount', { ascending: false })
          .order('transaction_date', { ascending: false })
      } else {
        query = query
          .order('transaction_date', { ascending: false })
          .order('created_at', { ascending: false })
      }

      // One extra row, purely to know whether a "Load more" button belongs on
      // screen without paying for a separate count query.
      query = applyTransactionFilter(
        query.range(from, from + size),
        filter,
        currentWallets,
        activeSearch,
      )

      const { data, error } = await query
      if (error) throw error

      const rows = data || []
      return { rows: rows.slice(0, size), hasMore: rows.length > size }
    },
    [filter, activeSearch],
  )

  const fetchData = useCallback(async () => {
    try {
      setPageError(null)
      const { data: wData, error: wError } = await supabase.from('wallets').select('*')
      if (wError) throw wError
      const walletList = wData || []
      setWallets(walletList)

      // Refetch everything currently on screen, not just the first page.
      // Resetting to page 0 here meant editing one row's category threw away
      // the other 150 the user had loaded, and so did every realtime event.
      const loaded = Math.max(loadedCountRef.current, PAGE_SIZE)

      const [page, countRes] = await Promise.all([
        fetchRange(0, loaded, walletList),
        // Counted across the whole table, not the loaded page -- a head query
        // returns the number without transferring any rows.
        excludeVoided(
          supabase
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq(NEEDS_REVIEW_FILTER.column, NEEDS_REVIEW_FILTER.value),
        ),
      ])

      setTransactions(page.rows)
      loadedCountRef.current = page.rows.length
      setHasMore(page.hasMore)
      setUnreviewedCount(countRes.count || 0)
    } catch (err) {
      console.error('Error fetching transactions:', err)
      // The empty-list state below says "No transactions found", which is a
      // wrong answer when the truth is "could not ask".
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [fetchRange])

  // Changing the filter is the one case that *should* go back to one page.
  useEffect(() => {
    loadedCountRef.current = 0
    setLoading(true)
    fetchData()
  }, [fetchData])

  useRealtimeRefresh(['transactions'], fetchData, { channelPrefix: 'transactions_page' })

  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      const page = await fetchRange(transactions.length, PAGE_SIZE, wallets)
      setTransactions(prev => {
        const next = [...prev, ...page.rows]
        loadedCountRef.current = next.length
        return next
      })
      setHasMore(page.hasMore)
    } catch (err) {
      console.error('Error loading more transactions:', err)
      toast.error('Failed to load more')
    } finally {
      setLoadingMore(false)
    }
  }

  // Wallet chips come from the wallets table, so a bank added in Settings is
  // immediately filterable. The old hardcoded GTBank/OPay/Cash list went stale
  // the moment Zenith, Polaris and PiggyVest were added.
  const filterOptions = useMemo(() => {
    const options = buildFilterOptions(wallets)
    // A category filter arrives by deep link, not from the standing chip row --
    // give it a chip so the active filter is visible and dismissible.
    if (filter.startsWith('category:')) {
      options.splice(1, 0, { id: filter, label: filter.slice('category:'.length) })
    }
    return options
  }, [wallets, filter])

  const getWalletName = (walletId, source) => {
    const found = wallets.find(w => w.id === walletId)
    if (found) return found.name
    if (source === 'gtbank') return 'GTBank'
    if (source === 'opay') return 'OPay'
    return 'Manual'
  }

  const filteredTransactions = transactions

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  /**
   * Categorise the explicitly selected rows.
   *
   * Amount, direction and date are untouched, so this needs no balance
   * arithmetic and goes straight to the table rather than through
   * correct_transaction.
   */
  const handleBulkCategorize = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return

    setUpdating(true)
    try {
      const { error } = await supabase
        .from('transactions')
        .update({ category: bulkCategory, reviewed: true })
        .in('id', ids)
      if (error) throw error

      // A batch should teach the model as much as one-at-a-time would, so the
      // rows that genuinely changed category are recorded the same way. Only
      // those: re-confirming a row the model already got right is agreement,
      // not a correction, and storing it as one would drown the real signal.
      const changed = transactions.filter(
        (t) => selectedIds.has(t.id) && t.category !== bulkCategory,
      )
      if (changed.length > 0) {
        const { error: correctionError } = await supabase.from('category_corrections').insert(
          changed.map((t) => ({
            recipient: t.recipient || null,
            description_snippet: (t.description || '').slice(0, 120) || null,
            corrected_category: bulkCategory,
          })),
        )
        if (correctionError) {
          console.warn('Could not record category corrections:', correctionError.message)
        }
      }

      toast.success(`${ids.length} transaction${ids.length === 1 ? '' : 's'} categorized ✓`)
      exitSelectMode()
      fetchData()
    } catch (err) {
      console.error('Error bulk categorizing:', err)
      toast.error('Failed to categorize: ' + (err.message || 'check connection'))
    } finally {
      setUpdating(false)
    }
  }

  const handleRowClick = (txn) => {
    if (selectMode) {
      toggleSelected(txn.id)
      return
    }
    if (expandedId === txn.id) {
      setExpandedId(null)
    } else {
      setExpandedId(txn.id)
      // Pre-filled with the model's suggestion, so accepting it is one tap and
      // only a disagreement costs a change.
      setEditCategory(txn.category || 'Uncategorized')
      // Seeded from the note alone. It used to fall back to `description`,
      // which combined with the write below meant opening a row and saving it
      // unchanged copied the bank's narration into the note.
      setEditNote(txn.note || '')
      setEditWantNeed(txn.want_or_need || null)
      setEditType(txn.type || 'debit')
      setEditAmount(txn.amount != null ? String(txn.amount) : '')
      setEditDate(txn.transaction_date || '')
      setConfirmVoidId(null)
    }
  }

  /**
   * Write a correction, through the RPC when it exists.
   *
   * The RPC is not ceremony. A manual row moved its wallet balance when it was
   * logged, so correcting a ₦5,000 cash spend to ₦500 -- or voiding it -- has
   * to move the balance back by the difference, in the same database
   * transaction as the edit. Two statements from the browser means a dropped
   * connection between them leaves the ledger and the balance disagreeing with
   * nothing to say which is lying. Synced rows carry no such debt: their
   * balance is whatever the bank's last alert said.
   *
   * The fallback covers the window between this deploying (which happens on
   * push) and migration 007 being run by hand: the edit still lands, only the
   * manual balance compensation is skipped.
   */
  const writeCorrection = async (txnId, fields) => {
    const { error } = await supabase.rpc('correct_transaction', {
      p_id: txnId,
      p_type: fields.type,
      p_amount: fields.amount,
      p_date: fields.date,
      p_category: fields.category,
      p_note: fields.note ?? null,
      p_want_or_need: fields.wantOrNeed ?? null,
      p_voided: fields.voided,
    })
    if (!error) return
    if (!isMissingFunctionError(error)) throw error

    console.warn('correct_transaction is missing -- run migration 007. Falling back.')
    const { error: updateError } = await supabase
      .from('transactions')
      .update({
        type: fields.type,
        amount: fields.amount,
        transaction_date: fields.date,
        category: fields.category,
        note: (fields.note || '').trim() || null,
        // `description` is deliberately not written. It holds the bank's own
        // narration, and an earlier version overwrote it with the note -- or,
        // when the note was empty, with the category name. That destroyed the
        // only durable record of what the bank actually said, which is also
        // the text a correction keys on.
        want_or_need: fields.wantOrNeed ?? null,
        voided: fields.voided,
        reviewed: true,
      })
      .eq('id', txnId)
    if (updateError) throw updateError
  }

  /**
   * Remember a disagreement so future categorization matches this habit.
   * Best-effort: failing to record a preference must not fail the edit the
   * user actually asked for.
   */
  const recordCategoryCorrection = async (original, category) => {
    const { error } = await supabase.from('category_corrections').insert({
      recipient: original.recipient || null,
      description_snippet: (original.description || '').slice(0, 120) || null,
      corrected_category: category,
    })
    if (error) console.warn('Could not record category correction:', error.message)
  }

  /**
   * Strike a transaction off without deleting it.
   *
   * Soft on purpose: the unique index on (source, transaction_id) is what stops
   * the sync re-inserting an email it has already read, so a hard-deleted
   * synced row would come straight back on the next run. A delete that silently
   * undoes itself is worse than none.
   */
  const handleVoid = async (txn) => {
    setUpdating(true)
    try {
      // Voided rows are excluded from every total, so the amount no longer
      // matters -- but the RPC validates it regardless, and sending the row's
      // own values keeps un-voiding from the dashboard a coherent operation.
      await writeCorrection(txn.id, {
        type: txn.type || 'debit',
        amount: Number(txn.amount) || 0.01,
        date: txn.transaction_date,
        category: txn.category || 'Uncategorized',
        note: txn.note,
        wantOrNeed: txn.want_or_need,
        voided: true,
      })

      toast.success('Transaction voided')
      setExpandedId(null)
      setConfirmVoidId(null)
      fetchData()
    } catch (err) {
      console.error('Error voiding transaction:', err)
      toast.error('Failed to void: ' + (err.message || 'check connection'))
    } finally {
      setUpdating(false)
    }
  }

  const handleSaveChanges = async (txnId) => {
    const checked = validateCorrection({ type: editType, amount: editAmount, date: editDate })
    if (!checked.ok) {
      toast.error(checked.error)
      return
    }

    setUpdating(true)
    try {
      const original = transactions.find(t => t.id === txnId)
      const categoryChanged = original && original.category !== editCategory

      await writeCorrection(txnId, {
        ...checked.value,
        category: editCategory,
        note: editNote.trim() || null,
        wantOrNeed: editWantNeed,
        voided: false,
      })

      if (categoryChanged) await recordCategoryCorrection(original, editCategory)

      toast.success('Transaction updated ✓')
      setExpandedId(null)
      fetchData()
    } catch (err) {
      console.error('Error updating transaction:', err)
      toast.error('Failed to update: ' + (err.message || 'check connection'))
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
              {filteredTransactions.length}{hasMore ? '+' : ''}
            </span>
          </h1>
          <p className="text-muted text-sm mt-0.5">Filter, review, and categorize transactions</p>
        </div>
        <button
          onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          className={`px-4 py-2.5 rounded-xl text-xs font-bold whitespace-nowrap border transition-all min-h-[48px] ${
            selectMode
              ? 'bg-accent text-black border-accent'
              : 'bg-card text-muted hover:text-white border-white/5'
          }`}
        >
          {selectMode ? 'Done' : 'Select'}
        </button>
      </div>

      {/* Search. Runs in Postgres, not over the loaded page -- otherwise it
          would only ever search the most recent 50 rows and confidently report
          nothing for anything older. */}
      <div className="relative">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search description, recipient, note or amount…"
          className="w-full pl-11 pr-4 py-3 bg-card border border-white/10 rounded-2xl text-white text-sm placeholder-muted focus:outline-none focus:border-accent min-h-[48px]"
        />
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">
          🔍
        </span>
      </div>

      {/* Filter Chips Horizontal Scroll */}
      <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {filterOptions.map((opt) => {
          const isActive = filter === opt.id
          const isReview = opt.id === 'Review'
          return (
            <button
              key={opt.id}
              onClick={() => setFilter(opt.id)}
              className={`px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all flex items-center gap-1.5 min-h-[48px] ${
                isActive
                  ? 'bg-accent text-black font-bold shadow-md shadow-accent/20'
                  : 'bg-card text-muted hover:text-white border border-white/5'
              }`}
            >
              <span>{opt.label}</span>
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
      {pageError ? (
        <ErrorState message={pageError} onRetry={fetchData} />
      ) : filteredTransactions.length === 0 ? (
        <div className="bg-card rounded-3xl p-12 border border-white/5 text-center space-y-3">
          <span className="text-4xl">{activeSearch ? '🔍' : '💳'}</span>
          <p className="text-base font-bold text-white">
            {activeSearch ? `Nothing matches “${activeSearch}”` : 'No transactions found'}
          </p>
          <p className="text-xs text-muted">
            {activeSearch
              ? 'Searched description, recipient, note and exact amount'
              : 'Try selecting a different filter or log a transaction'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredTransactions.map((t) => {
            const isExpanded = expandedId === t.id && !selectMode
            const isSelected = selectedIds.has(t.id)
            const isCredit = t.type === 'credit'
            const icon = getCategoryIcon(t.category)
            const walletName = getWalletName(t.wallet_id, t.source)
            const isUnreviewed = needsReview(t)

            return (
              <div
                key={t.id}
                className={`bg-card rounded-2xl border transition-all overflow-hidden ${
                  isSelected
                    ? 'border-accent bg-accent/5'
                    : isExpanded
                      ? 'border-accent bg-card/90 shadow-xl'
                      : 'border-white/5 hover:border-white/10'
                }`}
              >
                {/* Main Row */}
                <div
                  onClick={() => handleRowClick(t)}
                  className="p-4 flex items-center justify-between cursor-pointer min-h-[56px]"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    {selectMode && (
                      <span
                        className={`w-6 h-6 shrink-0 rounded-lg border-2 flex items-center justify-center text-xs font-black transition-all ${
                          isSelected
                            ? 'bg-accent border-accent text-black'
                            : 'border-white/20 text-transparent'
                        }`}
                      >
                        ✓
                      </span>
                    )}
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
                      {/* The model's reasoning, shown on unreviewed rows only.
                          On a settled row it is noise; here it is the whole
                          point -- it turns reviewing into confirming. */}
                      {isUnreviewed && t.explanation && (
                        <p className="text-[11px] text-muted/70 italic mt-1 line-clamp-2">
                          {t.explanation}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="text-right ml-3 shrink-0">
                    <span className={`text-base font-extrabold ${isCredit ? 'text-accent' : 'text-white'}`}>
                      {isCredit ? '+' : '-'}{formatNaira(t.amount)}
                    </span>
                    <p className="text-[10px] text-muted capitalize mt-0.5 flex items-center justify-end gap-1.5">
                      {/* How sure the parser was. It has ridden in the column
                          list all along and been rendered nowhere, which meant
                          a LOW-confidence guess looked exactly as settled as a
                          figure read straight off the bank's own email. Shown
                          only when it is not HIGH: a chip on every row is
                          decoration, a chip on the doubtful ones is a signal. */}
                      {t.confidence && t.confidence !== 'HIGH' && (
                        <span className={`px-1.5 py-0.5 rounded font-bold uppercase text-[9px] tracking-wide ${
                          t.confidence === 'LOW'
                            ? 'bg-red-500/15 text-red-300'
                            : 'bg-yellow-500/15 text-yellow-300'
                        }`}>
                          {t.confidence}
                        </span>
                      )}
                      <span>{t.source || 'manual'}</span>
                    </p>
                  </div>
                </div>

                {/* Expanded Details & Editor */}
                {isExpanded && (
                  <div className="px-4 pb-5 pt-2 border-t border-white/5 space-y-4 bg-background/50 animate-fade-in">

                    {/* Direction, amount and date -- what the parse can get
                        wrong about the money itself. These used to be fixable
                        only in the Supabase dashboard, and re-syncing would not
                        repair them either: the upsert's ignoreDuplicates throws
                        away the corrected second read. */}
                    <div>
                      <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                        Direction
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { value: 'debit', label: 'Money out', sign: '−' },
                          { value: 'credit', label: 'Money in', sign: '+' },
                        ].map(({ value, label, sign }) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setEditType(value)}
                            className={`py-3 rounded-xl text-xs font-bold border transition-all min-h-[48px] ${
                              editType === value
                                ? 'bg-accent/20 border-accent text-accent'
                                : 'bg-card border-white/5 text-muted hover:text-white'
                            }`}
                          >
                            {sign} {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                          Amount (₦)
                        </label>
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.01"
                          value={editAmount}
                          onChange={(e) => setEditAmount(e.target.value)}
                          className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-muted uppercase tracking-wider mb-2">
                          Date
                        </label>
                        <input
                          type="date"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                          className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
                        />
                      </div>
                    </div>

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

                    {/* Void, behind a second tap. Not a delete: the unique
                        index on (source, transaction_id) is what stops the sync
                        re-importing an email, so a hard-deleted synced row
                        would return on the next run. */}
                    <div className="pt-1">
                      {confirmVoidId === t.id ? (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleVoid(t)}
                              disabled={updating}
                              className="flex-1 py-3 bg-red-500/15 border border-red-500/40 text-red-300 font-bold text-sm rounded-xl hover:bg-red-500/25 transition-all min-h-[48px] disabled:opacity-50"
                            >
                              {updating ? 'Voiding…' : 'Yes, void it'}
                            </button>
                            <button
                              onClick={() => setConfirmVoidId(null)}
                              className="px-4 py-3 bg-white/5 text-muted hover:text-white text-sm font-semibold rounded-xl min-h-[48px]"
                            >
                              Keep
                            </button>
                          </div>
                          <p className="text-[11px] text-muted leading-relaxed">
                            Hides it from every list and every total. Nothing is deleted — the
                            record is what stops the sync importing this email again.
                          </p>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmVoidId(t.id)}
                          className="w-full py-2.5 text-xs font-semibold text-muted hover:text-red-300 transition-colors min-h-[44px]"
                        >
                          Void this transaction
                        </button>
                      )}
                    </div>

                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {hasMore && (
        <button
          onClick={handleLoadMore}
          disabled={loadingMore}
          className="w-full py-3.5 bg-card border border-white/5 text-muted hover:text-white text-sm font-semibold rounded-2xl transition-all min-h-[48px] disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
        </button>
      )}

      {/* Bulk bar. Sticks above the bottom nav so the count stays visible while
          scrolling to pick more rows. */}
      {selectMode && selectedIds.size > 0 && (
        <div className="fixed bottom-20 left-0 right-0 z-40 px-4 animate-fade-in">
          <div className="max-w-3xl mx-auto bg-card border border-accent/40 rounded-2xl shadow-2xl p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-white">
                {selectedIds.size} selected
              </span>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs font-semibold text-muted hover:text-white px-2 py-1"
              >
                Clear
              </button>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={bulkCategory}
                onChange={(e) => setBulkCategory(e.target.value)}
                className="flex-1 min-w-0 px-3 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
              >
                {Object.values(CATEGORIES).flat().map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              <button
                onClick={handleBulkCategorize}
                disabled={updating}
                className="px-5 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50 whitespace-nowrap"
              >
                {updating ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
