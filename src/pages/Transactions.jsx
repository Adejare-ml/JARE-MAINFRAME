import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatDate } from '../lib/formatters'
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
  queueAge,
  toDateOnly,
} from '../lib/queries'
import { createSequence } from '../lib/latest'
import { linkableDebts } from '../lib/debts'
import { validateCorrection, isMissingFunctionError } from '../lib/corrections'
import { ruleFromTransaction, findMatchingRule, likeLiteral, ruleExplanation } from '../lib/categoryRules'
import { hasColumn } from '../lib/schema'
import { pendingTransactions } from '../lib/pendingTransactions'
import { confirmBuzz } from '../lib/haptics'
import { resolveSwipe } from '../lib/swipeGesture'
import CategoryPickerSheet from '../components/ui/CategoryPickerSheet'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Money from '../components/ui/Money'
import Badge from '../components/ui/Badge'
import Label from '../components/ui/Label'
import Button, { buttonClasses } from '../components/ui/Button'
import Segmented from '../components/ui/Segmented'
import CategoryMark from '../components/ui/CategoryMark'
import Provenance from '../components/ui/Provenance'
import { Field, Input, Select, controlClasses } from '../components/ui/Field'
import { useNewIds } from '../components/daily/useNewIds'

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
  // A refetch after the first load (a chip, a search keystroke, a sort)
  // keeps the list and the search box mounted and shows this instead of the
  // skeleton: swapping the page out closed the phone keyboard on every
  // keystroke.
  const [refreshing, setRefreshing] = useState(false)
  const firstLoad = useRef(true)
  // Only the newest request may write the list: see src/lib/latest.js.
  const fetchSeq = useRef(createSequence())
  // The date of the oldest row waiting in review, so the queue has an age.
  const [oldestUnreviewed, setOldestUnreviewed] = useState(null)
  // Deep links from the Budget breakdown arrive as /transactions?category=Rent.
  const [searchParams, setSearchParams] = useSearchParams()
  const initialCategory = searchParams.get('category')
  // Daily HQ's "Review →" lands on the queue itself, not the whole ledger.
  const [filter, setFilter] = useState(
    searchParams.get('filter') ? searchParams.get('filter') : initialCategory ? `category:${initialCategory}` : 'All',
  )
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
  // "Always file this payee as <category>": off on every open, so a rule is
  // only ever made on purpose.
  const [editMakeRule, setEditMakeRule] = useState(false)
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
  // The open debts a row can be attached to from the editor ("Counts
  // toward"): the ingest function links repayments on arrival only, and
  // a loan showed ₦0 paid with three matching repayments in the ledger.
  const [debts, setDebts] = useState([])
  // The debt chosen in the expanded row editor; '' for none.
  const [editDebtId, setEditDebtId] = useState('')
  useEffect(() => {
    if (!hasColumn('transactions.debt_id')) return
    let cancelled = false
    supabase
      .from('debts')
      .select('id, counterparty, direction, kind, settled')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        setDebtNames(Object.fromEntries(data.map((d) => [d.id, d.counterparty])))
        setDebts(data)
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
  // Empty until a category is picked: Apply used to default to Uncategorized,
  // which cleared rows from the queue still uncategorised and taught the
  // corrections table that "Uncategorized" was the answer.
  const [bulkCategory, setBulkCategory] = useState('')

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
    const token = fetchSeq.current.next()
    const current = () => fetchSeq.current.isCurrent(token)
    try {
      setPageError(null)
      const { data: wData, error: wError } = await supabase.from('wallets').select('*')
      if (!current()) return
      if (wError) throw wError
      const walletList = wData || []
      setWallets(walletList)

      // Refetch everything currently on screen, not just the first page.
      // Resetting to page 0 here meant editing one row's category threw away
      // the other 150 the user had loaded, and so did every realtime event.
      const loaded = Math.max(loadedCountRef.current, PAGE_SIZE)

      const [page, countRes, oldestRes] = await Promise.all([
        fetchRange(0, loaded, walletList),
        // Counted across the whole table, not the loaded page -- a head query
        // returns the number without transferring any rows.
        excludeVoided(
          supabase
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq(NEEDS_REVIEW_FILTER.column, NEEDS_REVIEW_FILTER.value),
        ),
        // The oldest row still waiting: one row, so the queue has an age.
        excludeVoided(
          supabase
            .from('transactions')
            .select('transaction_date')
            .eq(NEEDS_REVIEW_FILTER.column, NEEDS_REVIEW_FILTER.value),
        )
          .order('transaction_date', { ascending: true })
          .limit(1)
          .maybeSingle(),
      ])
      // A newer fetch started while this one was in flight (a second chip
      // tap, an Undo toast's captured callback): its answer, not this one.
      if (!current()) return

      setTransactions(page.rows)
      loadedCountRef.current = page.rows.length
      setHasMore(page.hasMore)
      setUnreviewedCount(countRes.count || 0)
      setOldestUnreviewed(oldestRes.error ? null : oldestRes.data?.transaction_date || null)
    } catch (err) {
      if (!current()) return
      console.error('Error fetching transactions:', err)
      // The empty-list state below says "No transactions found", which is a
      // wrong answer when the truth is "could not ask".
      setPageError(err.message || 'Failed to load')
    } finally {
      if (current()) {
        firstLoad.current = false
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [fetchRange])

  // The latest fetcher, for callbacks that outlive a render: a toast's Undo
  // fires seconds later, with whatever chip is active then.
  const fetchDataRef = useRef(fetchData)
  fetchDataRef.current = fetchData

  // Changing the filter is the one case that *should* go back to one page.
  // The skeleton is for the first load only; after that the list stays
  // mounted (and the search box keeps focus) while the new answer arrives.
  useEffect(() => {
    loadedCountRef.current = 0
    if (firstLoad.current) setLoading(true)
    else setRefreshing(true)
    fetchData()
  }, [fetchData])

  useRealtimeRefresh(['transactions'], fetchData, { channelPrefix: 'transactions_page' })

  // Mirror the chip, range, direction and order into the URL; defaults are
  // dropped so a plain visit keeps a plain address. The chip was read from
  // the URL once and never written back, so a refresh lost it.
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    const wanted = [
      ['from', range.from, ''],
      ['to', range.to, ''],
      ['type', range.type, 'all'],
      ['sort', sort, 'newest'],
      ['filter', filter.startsWith('category:') ? '' : filter, 'All'],
      ['category', filter.startsWith('category:') ? filter.slice('category:'.length) : '', ''],
    ]
    for (const [key, value, fallback] of wanted) {
      if (value && value !== fallback) next.set(key, value)
      else next.delete(key)
    }
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, sort, filter])

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
    // Not a new sequence token: a chip change mid-flight starts its own
    // fetch, which supersedes this one, and the page must not be appended
    // to a list that belongs to another chip.
    const token = fetchSeq.current.current
    try {
      const page = await fetchRange(transactions.length, PAGE_SIZE, wallets)
      if (!fetchSeq.current.isCurrent(token)) return
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
  const reviewAge = queueAge(oldestUnreviewed, toDateOnly(new Date()))
  // Rows that arrive while the page is open (a realtime insert) play the
  // row-insertion motion once; the first load never animates.
  const isNewRow = useNewIds(filteredTransactions.map((t) => t.id), !loading)

  /**
   * Accept the rows as they are: the audit's category stands, the row
   * leaves the queue. For rows whose only flag was LOW confidence, this is
   * the whole review. No corrections row is written -- agreeing with the
   * model is not a correction, and storing it as one would drown the real
   * signal.
   */
  const handleBulkMarkReviewed = async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setUpdating(true)
    try {
      const { error } = await supabase.from('transactions').update({ reviewed: true }).in('id', ids)
      if (error) throw error
      toast.success(`${ids.length} transaction${ids.length === 1 ? '' : 's'} marked reviewed`)
      exitSelectMode()
      fetchData()
    } catch (err) {
      console.error('Error marking reviewed:', err)
      toast.error('Failed to mark reviewed: ' + (err.message || 'check connection'))
    } finally {
      setUpdating(false)
    }
  }

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
    if (!bulkCategory || bulkCategory === 'Uncategorized') {
      toast.error('Pick a category first')
      return
    }

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

      toast.success(`${ids.length} transaction${ids.length === 1 ? '' : 's'} categorized`)
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
      setEditMakeRule(false)
      // Seeded from the note alone. It used to fall back to `description`,
      // which combined with the write below meant opening a row and saving it
      // unchanged copied the bank's narration into the note.
      setEditNote(txn.note || '')
      setEditWantNeed(txn.want_or_need || null)
      setEditType(txn.type || 'debit')
      setEditAmount(txn.amount != null ? String(txn.amount) : '')
      setEditDate(txn.transaction_date || '')
      setEditDebtId(txn.debt_id || '')
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
   * "Always file this payee as <category>": one category rule (020), and
   * every other row from the same payee still waiting in review gets the
   * answer now, marked reviewed with a note saying which rule did it. A rule
   * that already names this payee is updated rather than doubled. Runs after
   * the edit itself has landed; a failure here is reported, never fatal.
   *
   * The re-file mirrors how ingest_alert_transaction applies a rule: a
   * case-insensitive substring of the recipient.
   */
  const teachRule = async (original, category) => {
    const rule = ruleFromTransaction(original, category)
    if (!rule) return null

    const { data: existing, error: readError } = await supabase
      .from('category_rules')
      .select('id, trigger_field, trigger_value, action_category')
      .eq('trigger_field', rule.trigger_field)
    if (readError) throw readError

    const match = findMatchingRule(existing, rule)
    const { error: writeError } = match
      ? await supabase.from('category_rules').update({ action_category: rule.action_category }).eq('id', match.id)
      : await supabase.from('category_rules').insert(rule)
    if (writeError) throw writeError

    const patch = { category: rule.action_category, reviewed: true }
    if (hasColumn('transactions.explanation')) patch.explanation = ruleExplanation(rule)
    const { data: refiled, error: refileError } = await excludeVoided(
      supabase
        .from('transactions')
        .update(patch)
        .eq('reviewed', false)
        // Same direction only: "Rent" taught on a debit must not file the
        // landlord's refund credit as Rent income.
        .eq('type', original.type || 'debit')
        .neq('id', original.id)
        .ilike('recipient', `%${likeLiteral(rule.trigger_value)}%`),
    ).select('id')
    if (refileError) throw refileError

    return { rule, updated: Boolean(match), refiled: (refiled || []).length }
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
      fetchDataRef.current()
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

      // The debt link is a plain column write under RLS: correct_transaction
      // has no debt parameter, and Debts.jsx sums linked rows itself.
      const nextDebtId = editDebtId || null
      if (hasColumn('transactions.debt_id') && (original?.debt_id || null) !== nextDebtId) {
        const { error: linkError } = await supabase.from('transactions').update({ debt_id: nextDebtId }).eq('id', txnId)
        if (linkError) throw linkError
      }

      let taught = null
      if (editMakeRule && original && hasColumn('category_rules.trigger_field')) {
        try {
          taught = await teachRule(original, editCategory)
        } catch (err) {
          console.warn('Could not save the category rule:', err)
          toast.error('Saved, but the rule was not: ' + (err.message || 'check connection'))
        }
      }

      if (taught) {
        const verb = taught.updated ? 'updated' : 'saved'
        toast.success(
          taught.refiled > 0
            ? `Rule ${verb} · ${taught.refiled} more from this payee filed as ${taught.rule.action_category}`
            : `Rule ${verb}`,
        )
      } else {
        toast.success('Transaction updated')
      }
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

  const countText = `${filteredTransactions.length}${hasMore ? '+' : ''} shown`
  const headerMeta = [
    filter === 'Review' && unreviewedCount > 0
      ? `${unreviewedCount} waiting${reviewAge ? `, ${reviewAge.label}` : ''}`
      : countText,
    refreshing ? 'Updating…' : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const sectionLabel = (text) => <Label as="p" className="block mb-1.5">{text}</Label>

  return (
    <div className="space-y-3 pb-6">
      <PageHeader
        title="Transactions"
        meta={headerMeta}
        actions={
          <Button
            size="sm"
            variant={selectMode ? 'primary' : 'secondary'}
            onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
          >
            {selectMode ? 'Done' : 'Select'}
          </Button>
        }
      />
      <span role="status" aria-live="polite" className="sr-only">
        {refreshing ? 'Updating…' : ''}
      </span>

      {/* Search. Runs in Postgres, not over the loaded page -- otherwise it
          would only ever search the most recent 50 rows and confidently report
          nothing for anything older. */}
      <div className="relative">
        <Icon name="search" size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search transactions"
          placeholder="Search description, recipient, note or amount…"
          className={`${controlClasses(false)} pl-10`}
        />
      </div>

      {/* Range, direction and order. Collapsed by default: the chips answer
          most questions, and three more controls above every visit would
          push the ledger itself below the fold on a phone. */}
      <div className="flex items-center justify-between gap-2">
        <Button
          size="sm"
          variant="ghost"
          icon="filter"
          onClick={() => setShowFilters((v) => !v)}
          aria-expanded={showFilters}
          className="min-w-0"
        >
          <span className="truncate">
            {showFilters ? 'Hide filters' : 'Filters'}
            {rangeSummary ? ` · ${rangeSummary}` : ''}
          </span>
        </Button>
        {(rangeSummary || sort !== 'newest') && (
          <Button size="sm" variant="ghost" onClick={clearRange}>
            Clear
          </Button>
        )}
      </div>
      {showFilters && (
        <Panel label="Filters">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Input
              label="From"
              type="date"
              value={range.from}
              max={range.to || undefined}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
            <Input
              label="To"
              type="date"
              value={range.to}
              min={range.from || undefined}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
            <div className="min-w-0">
              {sectionLabel('Direction')}
              <Segmented
                full
                label="Direction"
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'debit', label: 'Out' },
                  { value: 'credit', label: 'In' },
                ]}
                value={range.type}
                onChange={(id) => setRange((r) => ({ ...r, type: id }))}
              />
            </div>
            <Select label="Order" value={sort} onChange={(e) => setSort(e.target.value)} disabled={filter === 'Review'}>
              {SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        </Panel>
      )}

      {/* Filter chips. A scrolling row rather than a Segmented control: the
          options grow with wallets and a deep-linked category, and equal-width
          segments would not fit at phone width. */}
      <div className="flex gap-2 overflow-x-auto py-1.5 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0" role="group" aria-label="Filter">
        {filterOptions.map((opt) => {
          const isActive = filter === opt.id
          const isReview = opt.id === 'Review'
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFilter(opt.id)}
              aria-pressed={isActive}
              className={`${buttonClasses({ variant: 'secondary', size: 'sm' })} shrink-0 ${
                isActive ? 'bg-card border-border-strong text-foreground' : 'text-muted'
              }`}
            >
              <span>{opt.label}</span>
              {isReview && unreviewedCount > 0 && <Badge label={unreviewedCount} tone="warn" />}
            </button>
          )
        })}
      </div>

      {filter === 'Voided' && (
        <p className="text-body-sm text-muted">
          Left out of every list and every total. Restore one to bring it back.
        </p>
      )}

      {/* Rows logged this session, shown before the server (or the realtime
          refetch behind it) has confirmed them -- see
          lib/pendingTransactions.js. Only on the default, unfiltered view:
          a pending row is not yet a real transaction to filter or search. */}
      {filter === 'All' && !activeSearch && pending.length > 0 && (
        <Panel label="Saving" meta={`${pending.length}`} flush>
          <ListRows>
            {pending.map((p) => (
              <ListRow
                key={p.id}
                isNew
                leading={<CategoryMark category={p.category} />}
                title={p.description || p.category}
                subtitle="Saving…"
                trailing={
                  <Money
                    amount={p.type === 'credit' ? Number(p.amount) : -Number(p.amount)}
                    sign={p.type === 'credit'}
                    tone={p.type === 'credit' ? 'positive' : 'default'}
                  />
                }
              />
            ))}
          </ListRows>
        </Panel>
      )}

      {/* Transaction List */}
      {pageError ? (
        <ErrorState message={pageError} onRetry={fetchData} />
      ) : filteredTransactions.length === 0 ? (
        activeSearch ? (
          <Panel>
            <EmptyState
              title={`Nothing matches "${activeSearch}"`}
              message="Searched description, recipient, note and exact amount"
              actionLabel="Clear search"
              onAction={() => {
                setSearch('')
                setActiveSearch('')
              }}
            />
          </Panel>
        ) : filter !== 'All' ? (
          <Panel>
            <EmptyState
              title="Nothing in this filter"
              message="Try a different filter, or log a transaction"
              actionLabel="Clear filter"
              onAction={() => setFilter('All')}
            />
          </Panel>
        ) : (
          <>
            <Panel>
              <EmptyState
                title="No transactions yet"
                message="Log one by hand, or wait for the morning import of bank alerts (Settings, System shows when it last ran)"
                actionLabel="Log a transaction"
                onAction={() => openQuickLog('debit')}
              />
            </Panel>
            <div className="opacity-60 pointer-events-none select-none" aria-hidden="true">
              <Panel label="Preview" meta="Once you have some" flush>
                <ListRows>
                  {SAMPLE_TRANSACTIONS.map((t) => {
                    const isCredit = t.type === 'credit'
                    return (
                      <ListRow
                        key={t.id}
                        leading={<CategoryMark category={t.category} />}
                        title={t.description}
                        subtitle={t.category}
                        trailing={<Money amount={isCredit ? t.amount : -t.amount} sign={isCredit} tone={isCredit ? 'positive' : 'default'} />}
                      />
                    )
                  })}
                </ListRows>
              </Panel>
            </div>
          </>
        )
      ) : (
        <div className="space-y-3">
          {groupedTransactions.map((group) => (
          <Panel key={group.date} label={group.label === group.date ? formatDate(group.date) : group.label} meta={`${group.rows.length}`} flush>
            <div className="divide-y divide-border">
            {group.rows.map((t) => {
            const isExpanded = expandedId === t.id && !selectMode
            const isSelected = selectedIds.has(t.id)
            const isCredit = t.type === 'credit'
            const walletName = getWalletName(t.wallet_id, t.source)
            const isUnreviewed = needsReview(t)

            const isRevealed = revealedId === t.id && !selectMode

            return (
              <div key={t.id} className={`relative overflow-hidden ${isNewRow(t.id) ? 'row-enter' : ''}`}>
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
                    className={`absolute inset-y-0 right-0 w-20 flex items-center justify-center text-body-sm font-semibold disabled:opacity-50 ${
                      t.voided ? 'bg-accent text-on-accent' : 'bg-danger text-on-accent'
                    }`}
                  >
                    {t.voided ? 'Restore' : 'Void'}
                  </button>
                )}

                {/* Main Row. Composed here rather than with ListRow: it
                    carries the swipe handlers, the reveal transform and the
                    inline editor below it. */}
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={expandedId === t.id}
                  aria-pressed={selectMode ? isSelected : undefined}
                  onClick={() => handleRowClick(t)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleRowClick(t)
                    }
                  }}
                  onPointerDown={handleSwipeStart}
                  onPointerUp={handleSwipeEnd(t)}
                  style={{
                    transform: isRevealed ? 'translateX(-5rem)' : undefined,
                    transition: 'transform var(--dur-state) var(--ease-out), background-color var(--dur-state) var(--ease-standard)',
                  }}
                  className={`relative flex items-center gap-3 px-3 py-2 min-h-14 cursor-pointer ${
                    isSelected || isExpanded ? 'bg-surface-2' : 'bg-card hover:bg-surface-2'
                  }`}
                >
                  {selectMode && (
                    <span
                      aria-hidden="true"
                      className={`w-6 h-6 shrink-0 rounded-chip border-2 flex items-center justify-center ${
                        isSelected ? 'bg-accent border-accent text-on-accent' : 'border-border text-transparent'
                      }`}
                    >
                      <Icon name="check" size={14} />
                    </span>
                  )}
                  <CategoryMark category={t.category} />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-body text-foreground truncate min-w-0">
                        {t.description || t.category}
                      </p>
                      {t.want_or_need && (
                        <span className="shrink-0">
                          <Badge label={t.want_or_need} />
                        </span>
                      )}
                      {t.debt_id && (
                        <span className="min-w-0 max-w-[140px] truncate" title="Counts toward this debt">
                          <Badge label={`Debt · ${debtNames[t.debt_id] || 'Debt'}`} />
                        </span>
                      )}
                    </div>
                    {/* The date is the group header above; the line under the
                        title says what it was and which wallet it moved. */}
                    <p className="text-body-sm text-muted truncate">
                      {t.category} · {walletName}
                    </p>
                    {/* Where the row came from: the source and the time the
                        bank (or the hand-log) stamped on it. */}
                    <Provenance source={t.source} at={t.transaction_time} />
                    {/* Why it landed on this category -- the audit's own
                        reasoning, or the rule that filed it, folded into
                        one string by the ingest function. Shown on every row that has
                        one, not only unreviewed ones: a category chosen
                        with high confidence is still a change the AI made,
                        and "never a silent change" means it stays visible
                        even once you are not being asked to double-check it. */}
                    {t.explanation && (
                      <p className="flex items-center gap-1.5 mt-0.5 text-body-sm text-muted-dim min-w-0" title={t.explanation}>
                        <Icon name="info" size={14} className="shrink-0" />
                        <span className="truncate">{t.explanation}</span>
                      </p>
                    )}
                  </div>

                  <div className="shrink-0 flex flex-col items-end gap-1 text-right">
                    <Money
                      amount={isCredit ? Number(t.amount) : -Number(t.amount)}
                      sign={isCredit}
                      tone={isCredit ? 'positive' : 'default'}
                    />
                    {(isUnreviewed || (t.confidence && t.confidence !== 'HIGH')) && (
                      <span className="flex items-center gap-1">
                        {/* How sure the parser was. Shown only when it is not
                            HIGH: a chip on every row is decoration, a chip on
                            the doubtful ones is a signal. */}
                        {t.confidence && t.confidence !== 'HIGH' && (
                          <Badge label={t.confidence} tone={t.confidence === 'LOW' ? 'danger' : 'warn'} />
                        )}
                        {isUnreviewed && <Badge label="Review" tone="warn" />}
                      </span>
                    )}
                  </div>
                </div>

                {/* Expanded Details & Editor */}
                {isExpanded && (
                  <div className="px-3 pb-4 pt-3 border-t border-border space-y-4 bg-card lg:px-4">

                    {/* Direction, amount and date -- what the parse can get
                        wrong about the money itself. These used to be fixable
                        only in the Supabase dashboard, and re-syncing would not
                        repair them either: the upsert's ignoreDuplicates throws
                        away the corrected second read. */}
                    <div>
                      {sectionLabel('Direction')}
                      <Segmented
                        full
                        label="Direction"
                        options={[
                          { value: 'debit', label: 'Money out' },
                          { value: 'credit', label: 'Money in' },
                        ]}
                        value={editType}
                        onChange={setEditType}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <Input
                        label="Amount, naira"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="0.01"
                        value={editAmount}
                        onChange={(e) => setEditAmount(e.target.value)}
                      />
                      <Input label="Date" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                    </div>

                    {/* Category Selector */}
                    <div>
                      <Field label="Category">
                        {({ id }) => (
                          <button
                            id={id}
                            type="button"
                            onClick={() => setShowEditCategoryPicker(true)}
                            className={`${controlClasses(false)} flex items-center gap-2 text-left`}
                          >
                            <CategoryMark category={editCategory} size="sm" />
                            <span className="truncate">{editCategory}</span>
                          </button>
                        )}
                      </Field>

                      {/* The decision this queue exists for, offered where it is
                          made: one rule for the payee, and every other row from
                          them still waiting gets it too. Only when there is a
                          payee to key on and a category that is one -- see
                          ruleFromTransaction. */}
                      {hasColumn('category_rules.trigger_field') && ruleFromTransaction(t, editCategory) && (
                        <label className="mt-2 flex items-start gap-3 cursor-pointer min-h-12 py-2">
                          <input
                            type="checkbox"
                            checked={editMakeRule}
                            onChange={(e) => setEditMakeRule(e.target.checked)}
                            className="mt-0.5 w-5 h-5 accent-accent shrink-0"
                          />
                          <span className="text-body-sm text-muted">
                            Always file <span className="text-foreground font-semibold">{t.recipient}</span> as{' '}
                            <span className="text-foreground font-semibold">{editCategory}</span>
                            <span className="block">
                              Saves a category rule and files every other row from this payee still waiting for review.
                            </span>
                          </span>
                        </label>
                      )}
                    </div>

                    {/* Note Field */}
                    <Input
                      label="Note / description"
                      type="text"
                      value={editNote}
                      onChange={(e) => setEditNote(e.target.value)}
                      placeholder="Add a note..."
                    />

                    {/* Counts toward a debt. Only the open loans this row can
                        repay are offered: a debit for what I owe, a credit
                        for what is owed to me. */}
                    {hasColumn('transactions.debt_id') && linkableDebts(debts, { type: editType }).length > 0 && (
                      <Select
                        id={`debt-${t.id}`}
                        label="Counts toward"
                        value={editDebtId}
                        onChange={(e) => setEditDebtId(e.target.value)}
                      >
                        <option value="">No debt</option>
                        {linkableDebts(debts, { type: editType }).map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.counterparty}
                          </option>
                        ))}
                      </Select>
                    )}

                    {/* Want or Need Selector. Toggle buttons rather than a
                        Segmented control: "none" is a valid answer, and a
                        second tap on the chosen tag clears it. */}
                    <div>
                      {sectionLabel('Tag (want / need)')}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="group" aria-label="Tag">
                        {['need', 'want', 'obligation', 'emergency'].map(tag => (
                          <button
                            key={tag}
                            type="button"
                            onClick={() => setEditWantNeed(editWantNeed === tag ? null : tag)}
                            aria-pressed={editWantNeed === tag}
                            className={`${buttonClasses({ variant: 'secondary', size: 'md', full: true })} capitalize ${
                              editWantNeed === tag ? 'bg-card border-border-strong text-foreground' : 'text-muted'
                            }`}
                          >
                            {editWantNeed === tag && <Icon name="check" size={16} />}
                            {tag}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Save Button */}
                    <div className="flex items-center gap-2 pt-1">
                      <Button full loading={updating} onClick={() => handleSaveChanges(t.id)}>
                        {updating ? 'Saving...' : 'Save & mark reviewed'}
                      </Button>
                      <Button variant="secondary" onClick={() => setExpandedId(null)}>
                        Cancel
                      </Button>
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
                    <div className="space-y-2">
                      {t.voided ? (
                        <Button full variant="ghost" icon="undo" onClick={() => handleUnvoid(t)} disabled={updating}>
                          Restore this transaction
                        </Button>
                      ) : (
                        <>
                          <Button full variant="danger" icon="trash" onClick={() => handleVoid(t)} disabled={updating}>
                            {updating ? 'Voiding…' : 'Void this transaction'}
                          </Button>
                          <p className="text-body-sm text-muted-dim">
                            Hides it from every list and every total. Undo from the toast for
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
          </Panel>
          ))}
        </div>
      )}

      {hasMore && (
        <Button full variant="secondary" loading={loadingMore} onClick={handleLoadMore}>
          {loadingMore ? 'Loading…' : `Load ${PAGE_SIZE} more`}
        </Button>
      )}

      {/* Bulk bar. Sticks above the bottom nav so the count stays visible while
          scrolling to pick more rows. */}
      {selectMode && selectedIds.size > 0 && (
        <div className="fixed bottom-20 left-0 right-0 z-40 px-4">
          <div className="max-w-3xl mx-auto">
            <Panel
              label={`${selectedIds.size} selected`}
              action={
                <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                  Clear
                </Button>
              }
            >
              <div className="space-y-2">
                {/* Accept-as-is: the audit's category stands and the rows leave
                    the queue. Most LOW rows carry a real category and only a
                    confidence flag; this is their whole review. */}
                {filter === 'Review' && (
                  <Button full variant="secondary" onClick={handleBulkMarkReviewed} disabled={updating}>
                    {updating ? 'Working…' : `Mark ${selectedIds.size} reviewed as ${selectedIds.size === 1 ? 'it is' : 'they are'}`}
                  </Button>
                )}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowBulkCategoryPicker(true)}
                    className={`${controlClasses(false)} min-w-0 flex-1 flex items-center gap-2 text-left`}
                  >
                    {bulkCategory ? <CategoryMark category={bulkCategory} size="sm" /> : <Icon name="tag" size={16} className="text-muted" />}
                    <span className={`truncate ${bulkCategory ? '' : 'text-muted'}`}>{bulkCategory || 'Pick a category'}</span>
                  </button>
                  <Button onClick={handleBulkCategorize} disabled={updating || !bulkCategory} loading={updating}>
                    {updating ? 'Applying…' : 'Apply'}
                  </Button>
                </div>
              </div>
            </Panel>
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
