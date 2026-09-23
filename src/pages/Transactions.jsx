import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatNaira, formatDate, formatTime, getCategoryColor } from '../lib/formatters'
import { getCategoryIcon } from '../lib/constants'
import { toast } from '../lib/toast'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import { TransactionsSkeleton } from '../components/ui/PageSkeleton'
import { openQuickLog } from '../components/ui/QuickLog'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { groupByDate } from '../lib/transactionGroups'
import {
  transactionListColumns,
  PAGE_SIZE,
  applyTransactionFilter,
  buildFilterOptions,
  NEEDS_REVIEW_FILTER,
  needsReview,
  excludeVoided,
  voidedOnly,
  applyTransactionSort,
  SORT_OPTIONS,
} from '../lib/queries'
import { validateCorrection, isMissingFunctionError } from '../lib/corrections'
import { hasColumn } from '../lib/schema'
import { pendingTransactions } from '../lib/pendingTransactions'
import { confirmBuzz } from '../lib/haptics'
import { resolveSwipe } from '../lib/swipeGesture'
import CategoryPickerSheet from '../components/ui/CategoryPickerSheet'

/**
 * What a populated list looks like, shown dimmed and inert on a genuinely
 * empty ledger -- not filtered to zero, never synced or logged anything at
 * all. A first-time visitor cannot tell from an icon and a sentence what
 * this screen is FOR; three rows of the real shape answer that at a glance.
 */
const SAMPLE_TRANSACTIONS = [
  { id: 'sample-1', type: 'credit', amount: 150000, category: 'Uncategorized', description: 'Salary' },
  { id: 'sample-2', type: 'debit', amount: 12000, category: 'Feeding / Groceries', description: 'Market run' },
  { id: 'sample-3', type: 'debit', amount: 3500, category: 'Transport', description: 'Bolt ride' },
]

export default function Transactions() {
  const [transactions, setTransactions] = useState([])
  const [wallets, setWallets] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  // Deep links from the Budget breakdown arrive as /transactions?category=Rent.
  const [searchParams, setSearchParams] = useSearchParams()
  const initialCategory = searchParams.get('category')
  const [filter, setFilter] = useState(initialCategory ? `category:${initialCategory}` : 'All')
  // Range, direction and order live in the URL too, so a filtered view can
  // be bookmarked or sent, and survives a refresh.
  const [range, setRange] = useState(() => ({
    from: searchParams.get('from') || '',
    to: searchParams.get('to') || '',
    type: searchParams.get('type') || 'all',
  }))
  const [sort, setSort] = useState(() => searchParams.get('sort') || 'newest')
  const [showFilters, setShowFilters] = useState(
    () => Boolean(searchParams.get('from') || searchParams.get('to') || searchParams.get('type') || searchParams.get('sort')),
  )
  const [expandedId, setExpandedId] = useState(null)
  // The id of the row currently showing its swiped-open Void button, or
  // null. One at a time, same reasoning as expandedId -- a second row
  // sliding open mid-swipe on another would be confusing, not helpful.
  const [revealedId, setRevealedId] = useState(null)
  const swipeStart = useRef(null)
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
  const [showEditCategoryPicker, setShowEditCategoryPicker] = useState(false)
  const [showBulkCategoryPicker, setShowBulkCategoryPicker] = useState(false)

  // Rows logged from QuickLog (mounted globally, independent of this page)
  // that have not yet been confirmed by the server or arrived through the
  // realtime refetch -- see lib/pendingTransactions.js.
  const [pending, setPending] = useState([])
  useEffect(() => pendingTransactions.subscribe(setPending), [])

  // Two pieces of state for one box: `search` is what the field shows, and
  // `activeSearch` is what has actually been sent. Without the split, every
  // keystroke re-runs the query and refetches every page on screen.
  const [search, setSearch] = useState('')
  const [activeSearch, setActiveSearch] = useState('')

  // Counterparty per debt id, so a linked repayment row can say who it paid
  // rather than just that it paid someone. Loaded once; the table is tiny
  // and a database behind 029 has no rows that would need it.
  const [debtNames, setDebtNames] = useState({})
  useEffect(() => {
    if (!hasColumn('transactions.debt_id')) return
    let cancelled = false
    supabase
      .from('debts')
      .select('id, counterparty')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        setDebtNames(Object.fromEntries(data.map((d) => [d.id, d.counterparty])))
      })
    return () => {
      cancelled = true
    }
  }, [])

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
      const base = supabase.from('transactions').select(transactionListColumns())
      // The Voided chip is the one view that wants the rows every other
      // query hides -- and the only way back for a void whose Undo toast
      // has already gone.
      let query = filter === 'Voided' ? voidedOnly(base) : excludeVoided(base)

      query = applyTransactionSort(query, filter, sort)

      // One extra row, purely to know whether a "Load more" button belongs on
      // screen without paying for a separate count query.
      query = applyTransactionFilter(
        query.range(from, from + size),
        filter,
        currentWallets,
        activeSearch,
        range,
      )

      const { data, error } = await query
      if (error) throw error

      const rows = data || []
      return { rows: rows.slice(0, size), hasMore: rows.length > size }
    },
    [filter, activeSearch, sort, range],
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

  // Mirror range, direction and order into the URL; defaults are dropped so
  // a plain visit keeps a plain address.
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    const wanted = [
      ['from', range.from, ''],
      ['to', range.to, ''],
      ['type', range.type, 'all'],
      ['sort', sort, 'newest'],
    ]
    for (const [key, value, fallback] of wanted) {
      if (value && value !== fallback) next.set(key, value)
      else next.delete(key)
    }
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, sort])

  const rangeSummary = [
    range.from && range.to
      ? `${range.from} → ${range.to}`
      : range.from
        ? `from ${range.from}`
        : range.to
          ? `to ${range.to}`
          : '',
    range.type === 'debit' ? 'money out' : range.type === 'credit' ? 'money in' : '',
  ]
    .filter(Boolean)
    .join(', ')

  const clearRange = () => {
    setRange({ from: '', to: '', type: 'all' })
    setSort('newest')
  }

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
  const groupedTransactions = groupByDate(filteredTransactions)

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
    // A tap while the row is swiped open closes it rather than expanding the
    // editor -- the same "one tap to back out" a swipe-open row should have
    // everywhere else, and it means an accidental tap on a revealed row can
    // never fire the wrong action.
    if (revealedId === txn.id) {
      setRevealedId(null)
      return
    }
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
    }
  }

  /**
   * Swipe-left reveals the row's Void button; swipe-right (or a tap, see
   * handleRowClick) closes it again. Resolved once on release rather than
   * dragged live -- src/lib/swipeGesture.js's own thresholds are what keep
   * this from firing on a scroll or the tap-to-expand gesture, and a
   * two-state reveal (shown/not shown) needs no live tracking to get that
   * right.
   *
   * Inert whenever another gesture already owns the row: select mode (row
   * taps toggle selection instead) and an expanded row (its own buttons and
   * inputs must get every pointer event, not a swipe layered underneath).
   */
  const handleSwipeStart = (e) => {
    if (selectMode) return
    swipeStart.current = { x: e.clientX, y: e.clientY, t: e.timeStamp }
  }
  const handleSwipeEnd = (txn) => (e) => {
    const start = swipeStart.current
    swipeStart.current = null
    if (!start || selectMode || expandedId === txn.id) return

    const direction = resolveSwipe(start, { x: e.clientX, y: e.clientY, t: e.timeStamp })
    if (direction === 'left') setRevealedId(txn.id)
    else if (direction === 'right' && revealedId === txn.id) setRevealedId(null)
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

    const patch = {
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
      reviewed: true,
    }

    // A fallback that needs its own migration is not a fallback. This path runs
    // when 007 has not been applied, and someone in that position has very
    // likely not applied 006 either -- writing `voided` would fail the rescue
    // for the same class of reason it was rescuing from. The rest of the
    // correction still lands; only the void does not, and the button that asks
    // for it is hidden when the column is absent.
    if (hasColumn('transactions.voided')) patch.voided = fields.voided

    const { error: updateError } = await supabase
      .from('transactions')
      .update(patch)
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
   *
   * Acts on the first tap now, backed by a 5-second Undo toast rather than a
   * confirm-then-void two-tap sequence -- one less decision for something
   * this reversible, and undoing it is the exact same write with `voided`
   * flipped back, already proven correct by handleSaveChanges' own
   * un-voiding-on-edit path.
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

      confirmBuzz()
      toast.success('Transaction voided', {
        duration: 5000,
        action: { label: 'Undo', onClick: () => handleUnvoid(txn) },
      })
      setExpandedId(null)
      fetchData()
    } catch (err) {
      console.error('Error voiding transaction:', err)
      toast.error('Failed to void: ' + (err.message || 'check connection'))
    } finally {
      setUpdating(false)
    }
  }

  /** The Undo action on a "Transaction voided" toast -- the same write, `voided` flipped back. */
  const handleUnvoid = async (txn) => {
    try {
      await writeCorrection(txn.id, {
        type: txn.type || 'debit',
        amount: Number(txn.amount) || 0.01,
        date: txn.transaction_date,
        category: txn.category || 'Uncategorized',
        note: txn.note,
        wantOrNeed: txn.want_or_need,
        voided: false,
      })
      toast.success('Restored')
      fetchData()
    } catch (err) {
      console.error('Error restoring transaction:', err)
      toast.error('Could not restore: ' + (err.message || 'check connection'))
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
    return <TransactionsSkeleton />
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
          className="w-full pl-11 pr-4 py-3 bg-card border border-white/10 rounded-2xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
        />
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted text-sm pointer-events-none">
          🔍
        </span>
      </div>

      {/* Range, direction and order. Collapsed by default: the chips answer
          most questions, and three more controls above every visit would
          push the ledger itself below the fold on a phone. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className="text-xs font-semibold text-muted hover:text-white min-h-[40px] px-1"
          >
            {showFilters ? 'Hide filters' : 'Filters'}
            {rangeSummary ? ` · ${rangeSummary}` : ''}
          </button>
          {(rangeSummary || sort !== 'newest') && (
            <button type="button" onClick={clearRange} className="text-xs font-semibold text-accent min-h-[40px] px-1">
              Clear
            </button>
          )}
        </div>
        {showFilters && (
          <div className="bg-card rounded-2xl border border-white/5 p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label className="text-xs text-muted">
              From
              <input
                type="date"
                value={range.from}
                max={range.to || undefined}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="mt-1 w-full px-3 py-2 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[44px] focus:outline-none focus:border-accent"
              />
            </label>
            <label className="text-xs text-muted">
              To
              <input
                type="date"
                value={range.to}
                min={range.from || undefined}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="mt-1 w-full px-3 py-2 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[44px] focus:outline-none focus:border-accent"
              />
            </label>
            <div className="text-xs text-muted">
              Direction
              <div className="mt-1 flex bg-background rounded-xl border border-white/10 p-0.5" role="group" aria-label="Direction">
                {[
                  ['all', 'All'],
                  ['debit', 'Out'],
                  ['credit', 'In'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRange((r) => ({ ...r, type: id }))}
                    aria-pressed={range.type === id}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold min-h-[40px] ${
                      range.type === id ? 'bg-accent text-black' : 'text-muted hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="text-xs text-muted">
              Order
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                disabled={filter === 'Review'}
                className="mt-1 w-full px-3 py-2 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[44px] focus:outline-none focus:border-accent disabled:opacity-50"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
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

      {/* Rows logged this session, shown before the server (or the realtime
          refetch behind it) has confirmed them -- see
          lib/pendingTransactions.js. Only on the default, unfiltered view:
          a pending row is not yet a real transaction to filter or search. */}
      {filter === 'Voided' && (
        <p className="text-[11px] text-muted-dim px-1">
          Left out of every list and every total. Restore one to bring it back.
        </p>
      )}

      {filter === 'All' && !activeSearch && pending.length > 0 && (
        <div className="space-y-2 mb-3">
          {pending.map((p) => (
            <div
              key={p.id}
              className="bg-card/60 rounded-2xl border border-dashed border-white/10 p-4 flex items-center justify-between animate-pulse"
            >
              <div className="flex items-center gap-3.5 min-w-0">
                <div className="w-11 h-11 rounded-2xl bg-background flex items-center justify-center text-xl border border-white/5">
                  {getCategoryIcon(p.category)}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white truncate">{p.description || p.category}</p>
                  <p className="text-xs text-muted mt-0.5">Syncing…</p>
                </div>
              </div>
              <span className={`text-sm font-bold flex-shrink-0 ml-3 money ${p.type === 'credit' ? 'text-accent' : 'text-white'}`}>
                {p.type === 'credit' ? '+' : '-'}{formatNaira(p.amount)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Transaction List */}
      {pageError ? (
        <ErrorState message={pageError} onRetry={fetchData} />
      ) : filteredTransactions.length === 0 ? (
        activeSearch ? (
          <EmptyState
            icon="🔍"
            title={`Nothing matches "${activeSearch}"`}
            message="Searched description, recipient, note and exact amount"
            actionLabel="Clear search"
            onAction={() => {
              setSearch('')
              setActiveSearch('')
            }}
          />
        ) : filter !== 'All' ? (
          <EmptyState
            icon="💳"
            title="Nothing in this filter"
            message="Try a different filter, or log a transaction"
            actionLabel="Clear filter"
            onAction={() => setFilter('All')}
          />
        ) : (
          <div className="space-y-5">
            <EmptyState
              icon="💳"
              title="No transactions yet"
              message="Log one by hand, or connect Gmail in Settings to import bank alerts automatically"
              actionLabel="Log a transaction"
              onAction={() => openQuickLog('debit')}
            />
            <div className="opacity-40 pointer-events-none select-none space-y-2" aria-hidden="true">
              <p className="text-[10px] text-muted uppercase tracking-wider text-center">
                Preview — what this looks like once you have some
              </p>
              {SAMPLE_TRANSACTIONS.map((t) => {
                const isCredit = t.type === 'credit'
                return (
                  <div
                    key={t.id}
                    className="bg-card rounded-2xl border border-white/5 p-4 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="relative">
                        <div
                          className={`w-11 h-11 rounded-2xl bg-background flex items-center justify-center text-xl border ${
                            isCredit ? 'border-accent/40' : 'border-white/5'
                          }`}
                        >
                          {getCategoryIcon(t.category)}
                        </div>
                        <span
                          className={`absolute -bottom-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border border-card ${getCategoryColor(t.category)}`}
                        />
                      </div>
                      <p className="text-sm font-bold text-white truncate">{t.description}</p>
                    </div>
                    <span className={`text-sm font-bold ${isCredit ? 'text-accent' : 'text-white'}`}>
                      {isCredit ? '+' : '-'}{formatNaira(t.amount)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      ) : (
        <div className="space-y-5">
          {groupedTransactions.map((group) => (
          <div key={group.date} className="space-y-2">
            <div className="sticky top-0 z-10 -mx-1 px-1 py-1.5 bg-background/95 backdrop-blur-sm">
              <span className="text-xs font-bold text-muted uppercase tracking-wider">{group.label}</span>
            </div>
            {group.rows.map((t) => {
            const isExpanded = expandedId === t.id && !selectMode
            const isSelected = selectedIds.has(t.id)
            const isCredit = t.type === 'credit'
            const icon = getCategoryIcon(t.category)
            const categoryColor = getCategoryColor(t.category)
            const walletName = getWalletName(t.wallet_id, t.source)
            const isUnreviewed = needsReview(t)

            const isRevealed = revealedId === t.id && !selectMode

            return (
              <div
                key={t.id}
                className={`relative bg-card rounded-2xl border transition-all overflow-hidden ${
                  isSelected
                    ? 'border-accent bg-accent/5'
                    : isExpanded
                      ? 'border-accent bg-card/90 shadow-xl'
                      : 'border-white/5 hover:border-white/10'
                }`}
              >
                {/* Sits behind the Main Row, exposed only once that row has
                    been swiped left -- see handleSwipeStart/End. A tap here
                    reuses the exact same one-tap-plus-Undo-toast handleVoid
                    every other Void button in this page already calls, so a
                    false-positive swipe costs nothing worse than an easily
                    undone void. */}
                {!selectMode && hasColumn('transactions.voided') && (
                  <button
                    type="button"
                    onClick={() => {
                      const act = t.voided ? handleUnvoid : handleVoid
                      act(t)
                      setRevealedId(null)
                    }}
                    disabled={updating}
                    aria-hidden={!isRevealed}
                    tabIndex={isRevealed ? 0 : -1}
                    className={`absolute inset-y-0 right-0 w-20 flex items-center justify-center text-xs font-bold disabled:opacity-50 ${
                      t.voided ? 'bg-accent/90 text-black' : 'bg-red-500/90 text-white'
                    }`}
                  >
                    {t.voided ? 'Restore' : 'Void'}
                  </button>
                )}

                {/* Main Row */}
                <div
                  onClick={() => handleRowClick(t)}
                  onPointerDown={handleSwipeStart}
                  onPointerUp={handleSwipeEnd(t)}
                  style={{
                    transform: isRevealed ? 'translateX(-5rem)' : undefined,
                    transition: 'transform 0.2s ease',
                  }}
                  className="relative bg-card p-4 flex items-center justify-between cursor-pointer min-h-[56px]"
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
                      <div
                        className={`w-11 h-11 rounded-2xl bg-background flex items-center justify-center text-xl border ${
                          isCredit ? 'border-accent/40' : 'border-white/5'
                        }`}
                      >
                        {icon}
                      </div>
                      {/* Category color, consistent with CategoryBreakdown and
                          Badge -- the same getCategoryColor() class, not a
                          second palette to keep in sync with it. */}
                      <span
                        className={`absolute -bottom-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border border-card ${categoryColor}`}
                        aria-hidden="true"
                      />
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
                        {t.debt_id && (
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-teal-500/15 text-teal-300 border border-teal-500/30 truncate max-w-[140px]"
                            title="Counts toward this debt"
                          >
                            🤝 {debtNames[t.debt_id] || 'Debt'}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted mt-0.5">
                        {walletName} · {formatDate(t.transaction_date)} {t.transaction_time ? `at ${formatTime(t.transaction_time)}` : ''}
                      </p>
                      {/* Why it landed on this category -- the model's own
                          reasoning, or a rule/structural override's, already
                          folded into one string by the sync pipeline (see
                          scripts/gmail-sync.mjs). Shown on every row that has
                          one, not only unreviewed ones: a category chosen
                          with high confidence is still a change the AI made,
                          and "never a silent change" means it stays visible
                          even once you are not being asked to double-check it. */}
                      {t.explanation && (
                        <span
                          className="inline-flex items-center gap-1 max-w-full mt-1 px-2 py-0.5 rounded-full bg-white/5 text-muted-dim text-[10px] leading-tight"
                          title={t.explanation}
                        >
                          <span aria-hidden="true">💡</span>
                          <span className="truncate">{t.explanation}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right ml-3 shrink-0">
                    <span className={`text-base font-extrabold tabular-nums money ${isCredit ? 'text-accent' : 'text-white'}`}>
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
                      <button
                        type="button"
                        onClick={() => setShowEditCategoryPicker(true)}
                        className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px] flex items-center gap-2"
                      >
                        <span className="text-lg" aria-hidden="true">{getCategoryIcon(editCategory)}</span>
                        <span className="truncate">{editCategory}</span>
                      </button>
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
                        className="w-full px-4 py-3 bg-card border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
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

                    {/* One tap, backed by a 5-second Undo toast rather than a
                        second confirm tap -- see handleVoid. Not a delete:
                        the unique index on (source, transaction_id) is what
                        stops the sync re-importing an email, so a
                        hard-deleted synced row would return on the next run.

                        Hidden entirely until migration 006 has run. Offering a
                        button that cannot work, and reporting a Postgres error
                        when it is pressed, is worse than not offering it -- the
                        banner already explains what to run. */}
                    {hasColumn('transactions.voided') && (
                    <div className="pt-1">
                      {t.voided ? (
                        <button
                          onClick={() => handleUnvoid(t)}
                          disabled={updating}
                          className="w-full py-2.5 text-xs font-semibold text-accent hover:text-white transition-colors min-h-[44px] disabled:opacity-50"
                        >
                          Restore this transaction
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => handleVoid(t)}
                            disabled={updating}
                            className="w-full py-2.5 text-xs font-semibold text-muted hover:text-red-300 transition-colors min-h-[44px] disabled:opacity-50"
                          >
                            {updating ? 'Voiding…' : 'Void this transaction'}
                          </button>
                          <p className="text-[11px] text-muted-dim leading-relaxed">
                            Hides it from every list and every total -- undo from the toast for
                            the next five seconds, or find it under the Voided filter and
                            restore it any time after.
                          </p>
                        </>
                      )}
                    </div>
                    )}

                  </div>
                )}
              </div>
            )
            })}
          </div>
          ))}
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
              <button
                type="button"
                onClick={() => setShowBulkCategoryPicker(true)}
                className="flex-1 min-w-0 px-3 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px] flex items-center gap-2"
              >
                <span className="text-lg" aria-hidden="true">{getCategoryIcon(bulkCategory)}</span>
                <span className="truncate">{bulkCategory}</span>
              </button>
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

      {/* Neither of these has an ancestor Sheet open, unlike GoalForm and
          CategoryRules -- safe to use the standalone wrapped picker here. */}
      <CategoryPickerSheet
        isOpen={showEditCategoryPicker}
        onClose={() => setShowEditCategoryPicker(false)}
        value={editCategory}
        onChange={setEditCategory}
        title="Category"
      />
      <CategoryPickerSheet
        isOpen={showBulkCategoryPicker}
        onClose={() => setShowBulkCategoryPicker(false)}
        value={bulkCategory}
        onChange={setBulkCategory}
        title="Recategorise as"
      />
    </div>
  )
}
