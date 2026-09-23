import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatNaira, formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import Sheet from '../components/ui/Sheet'
import { DebtsSkeleton } from '../components/ui/PageSkeleton'
import { openQuickLog } from '../components/ui/QuickLog'
import { confirmBuzz } from '../lib/haptics'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  DIRECTIONS,
  KINDS,
  isRotating,
  outstanding,
  repaymentProgress,
  cycleStatus,
  daysUntil,
  debtTotals,
  payoffProjection,
  paidTotals,
  linkedPayments,
  repayingType,
} from '../lib/debts'
import { hasColumn } from '../lib/schema'

const EMPTY_FORM = {
  direction: 'i_owe',
  kind: 'loan',
  counterparty: '',
  principal: '',
  amount_paid: '',
  cycle_size: '',
  cycle_position: '',
  contribution: '',
  due_date: '',
  payout_date: '',
  monthly_payment: '',
  notes: '',
}

export default function Debts() {
  const [debts, setDebts] = useState([])
  // Ledger rows that carry a debt_id, any debt's. What a loan has actually
  // been paid is derived from these plus the typed baseline, so voiding a
  // payment un-counts it with no write here -- see lib/debts.js paidTotal.
  const [linkedRows, setLinkedRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [tab, setTab] = useState('all')

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  // Inline, next to the field, instead of a full-width toast banner.
  const [formError, setFormError] = useState(null)
  const [shake, setShake] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  // Before 029 there is no link column, so the typed amount is the whole
  // answer and no second query is sent.
  const linkLive = hasColumn('transactions.debt_id')

  const fetchDebts = useCallback(async () => {
    try {
      setPageError(null)
      const linkedColumns = [
        'id',
        'debt_id',
        'amount',
        'type',
        'transaction_date',
        hasColumn('transactions.voided') ? 'voided' : null,
      ]
        .filter(Boolean)
        .join(', ')

      const [debtsRes, linkedRes] = await Promise.all([
        supabase
          .from('debts')
          .select('*')
          .order('settled', { ascending: true })
          .order('created_at', { ascending: false }),
        linkLive
          ? supabase.from('transactions').select(linkedColumns).not('debt_id', 'is', null)
          : Promise.resolve({ data: [], error: null }),
      ])

      if (debtsRes.error) throw debtsRes.error
      setDebts(debtsRes.data || [])
      // A failed payments query costs the derived totals, not the page:
      // the cards fall back to the typed amount with a console warning.
      if (linkedRes.error) {
        console.warn('Linked payments could not be loaded:', linkedRes.error.message)
        setLinkedRows([])
      } else {
        setLinkedRows(linkedRes.data || [])
      }
    } catch (err) {
      console.error('Error loading debts:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [linkLive])

  useEffect(() => {
    fetchDebts()
  }, [fetchDebts])

  // Transactions too: a repayment logged from this page, or voided from the
  // ledger, changes the numbers on these cards.
  useRealtimeRefresh(['debts', 'transactions'], fetchDebts, { channelPrefix: 'debts' })

  const paidByDebt = useMemo(() => paidTotals(debts, linkedRows), [debts, linkedRows])
  const totals = useMemo(() => debtTotals(debts, paidByDebt), [debts, paidByDebt])

  const visible = debts.filter(d => {
    if (tab === 'all') return true
    if (tab === 'rotating') return isRotating(d.kind)
    return d.direction === tab && !isRotating(d.kind)
  })

  const openAdd = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setShowModal(true)
  }

  const openEdit = (debt) => {
    setEditing(debt)
    setFormError(null)
    setForm({
      direction: debt.direction,
      kind: debt.kind,
      counterparty: debt.counterparty || '',
      principal: debt.principal != null ? String(debt.principal) : '',
      amount_paid: debt.amount_paid != null ? String(debt.amount_paid) : '',
      cycle_size: debt.cycle_size != null ? String(debt.cycle_size) : '',
      cycle_position: debt.cycle_position != null ? String(debt.cycle_position) : '',
      contribution: debt.contribution != null ? String(debt.contribution) : '',
      due_date: debt.due_date || '',
      payout_date: debt.payout_date || '',
      monthly_payment: debt.monthly_payment != null ? String(debt.monthly_payment) : '',
      notes: debt.notes || '',
    })
    setShowModal(true)
  }

  const fail = (message) => {
    setFormError(message)
    setShake(true)
    setTimeout(() => setShake(false), 400)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.counterparty.trim()) {
      fail('Who is this with?')
      return
    }

    const rotating = isRotating(form.kind)
    const num = (v) => (v === '' ? null : Number(v))

    if (rotating && form.cycle_size !== '' && form.cycle_position !== '') {
      if (Number(form.cycle_position) > Number(form.cycle_size)) {
        fail(`Round ${form.cycle_position} is past the end of a ${form.cycle_size}-round cycle`)
        return
      }
    }

    setFormError(null)
    setSaving(true)
    try {
      const payload = {
        direction: form.direction,
        kind: form.kind,
        counterparty: form.counterparty.trim(),
        principal: num(form.principal) || 0,
        amount_paid: num(form.amount_paid) || 0,
        // Cycle fields are meaningless on a loan; null them so switching kind
        // does not leave stale numbers behind.
        cycle_size: rotating ? num(form.cycle_size) : null,
        cycle_position: rotating ? num(form.cycle_position) : null,
        contribution: rotating ? num(form.contribution) : null,
        due_date: form.due_date || null,
        payout_date: rotating ? form.payout_date || null : null,
        // Meaningless on a rotating cycle -- there is no single balance to pay
        // down, only rounds. Omitted rather than sent as null on a database
        // behind 021, same reasoning as GoalForm's icon field.
        ...(hasColumn('debts.monthly_payment')
          ? { monthly_payment: rotating ? null : num(form.monthly_payment) }
          : {}),
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      }

      const { error } = editing
        ? await supabase.from('debts').update(payload).eq('id', editing.id)
        : await supabase.from('debts').insert(payload)
      if (error) throw error

      confirmBuzz()
      toast.success(editing ? 'Updated ✓' : 'Added ✓')
      fetchDebts()

      // A brief checkmark before the sheet closes, rather than it vanishing
      // the instant the request resolves.
      setJustSaved(true)
      setTimeout(() => {
        setShowModal(false)
        setJustSaved(false)
      }, 220)
    } catch (err) {
      console.error('Error saving debt:', err)
      toast.error('Failed to save: ' + (err.message || 'check connection'))
    } finally {
      setSaving(false)
    }
  }

  const toggleSettled = async (debt) => {
    const { error } = await supabase
      .from('debts')
      .update({ settled: !debt.settled, updated_at: new Date().toISOString() })
      .eq('id', debt.id)

    if (error) toast.error('Failed to update: ' + error.message)
    else {
      if (!debt.settled) confirmBuzz()
      toast.success(debt.settled ? 'Reopened' : 'Marked settled ✓')
      fetchDebts()
    }
  }

  const handleDelete = async (id) => {
    const { error } = await supabase.from('debts').delete().eq('id', id)
    if (error) toast.error('Failed to delete: ' + error.message)
    else {
      toast.success('Deleted')
      setConfirmDeleteId(null)
      fetchDebts()
    }
  }

  if (loading) {
    return <DebtsSkeleton />
  }

  if (pageError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Debts 🤝</h1>
        <ErrorState message={pageError} onRetry={fetchDebts} />
      </div>
    )
  }

  const rotating = isRotating(form.kind)

  return (
    <div className="space-y-6 pb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Debts 🤝</h1>
          <p className="text-muted text-sm mt-0.5">Loans, ajo and esusu</p>
        </div>
        <button
          onClick={openAdd}
          className="px-4 py-2.5 bg-accent text-black rounded-xl text-sm font-bold min-h-[48px] flex-shrink-0"
        >
          + New
        </button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">I owe</p>
          <p className="text-lg font-bold text-red-400 tabular-nums money">{formatNaira(totals.iOwe)}</p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Owed to me</p>
          <p className="text-lg font-bold text-accent tabular-nums money">{formatNaira(totals.owedToMe)}</p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">In cycles</p>
          <p className="text-lg font-bold text-blue-400 tabular-nums money">{formatNaira(totals.inCycles)}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {[
          { id: 'all', label: 'All' },
          { id: 'i_owe', label: 'I owe' },
          { id: 'owed_to_me', label: 'Owed to me' },
          { id: 'rotating', label: 'Ajo / Esusu' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap min-h-[48px] transition-all ${
              tab === t.id
                ? 'bg-accent text-black'
                : 'bg-card text-muted hover:text-white border border-white/5'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="bg-card rounded-3xl border border-white/5">
          <EmptyState
            icon="🤝"
            title={tab === 'all' ? 'Nothing here yet' : 'Nothing in this tab'}
            message={
              tab === 'all'
                ? "Track a loan, or an ajo cycle so you know which round you're in and when the pot reaches you"
                : 'Try a different tab, or add a debt'
            }
            actionLabel="+ New debt"
            onAction={openAdd}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(debt => {
            const cycle = cycleStatus(debt)
            const paid = paidByDebt[debt.id]
            const payments = linkedPayments(linkedRows, debt)
            const progress = repaymentProgress(debt, paid)
            const dueIn = daysUntil(debt.due_date)
            const payoutIn = daysUntil(debt.payout_date)
            const kindMeta = KINDS.find(k => k.value === debt.kind)

            return (
              <div
                key={debt.id}
                className={`bg-card rounded-2xl p-5 border transition-all ${
                  debt.settled ? 'border-white/5 opacity-50' : 'border-white/10'
                }`}
              >
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span aria-hidden="true">{kindMeta?.icon}</span>
                      <h3 className="text-sm font-bold text-white truncate">{debt.counterparty}</h3>
                      {debt.settled && (
                        <span className="text-[9px] bg-white/5 text-muted px-1.5 py-0.5 rounded-full uppercase font-bold">
                          Settled
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted mt-0.5">
                      {kindMeta?.label}
                      {!isRotating(debt.kind) &&
                        ` · ${DIRECTIONS.find(d => d.value === debt.direction)?.label}`}
                    </p>
                  </div>

                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => openEdit(debt)}
                      aria-label={`Edit ${debt.counterparty}`}
                      className="w-11 h-11 flex items-center justify-center rounded-xl hover:bg-white/5 text-muted hover:text-white"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(debt.id)}
                      aria-label={`Delete ${debt.counterparty}`}
                      className="w-11 h-11 flex items-center justify-center rounded-xl hover:bg-red-500/10 text-muted hover:text-red-400"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {/* Rotating savings: the part the ledger cannot tell you */}
                {cycle ? (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <p className="text-sm text-white font-semibold">
                        Round {cycle.position} of {cycle.size}
                      </p>
                      <p className="text-xs text-muted tabular-nums">
                        <span className="money">{formatNaira(cycle.contributed)}</span> in
                      </p>
                    </div>
                    <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-400 rounded-full"
                        style={{ width: `${(cycle.position / cycle.size) * 100}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-muted">
                      {cycle.roundsLeft === 0
                        ? 'Final round'
                        : `${cycle.roundsLeft} round${cycle.roundsLeft === 1 ? '' : 's'} to go`}
                      {debt.contribution && (
                        <>
                          {' · '}
                          <span className="money">{formatNaira(debt.contribution)}</span> each
                        </>
                      )}
                      {cycle.expectedPot && (
                        <>
                          {' · pot '}
                          <span className="money">{formatNaira(cycle.expectedPot)}</span>
                        </>
                      )}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <p className="text-lg font-bold text-white tabular-nums money">
                        {formatNaira(outstanding(debt, paid))}
                      </p>
                      {Number(debt.principal) > 0 && (
                        <p className="text-xs text-muted tabular-nums">
                          of <span className="money">{formatNaira(debt.principal)}</span>
                        </p>
                      )}
                    </div>
                    {progress != null && (
                      <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            debt.direction === 'i_owe' ? 'bg-red-400' : 'bg-accent'
                          }`}
                          style={{ width: `${progress * 100}%` }}
                        />
                      </div>
                    )}
                    {payments.length > 0 && (
                      <p className="text-[11px] text-muted">
                        🤝 {payments.length} payment{payments.length === 1 ? '' : 's'} from the ledger ·{' '}
                        <span className="money">
                          {formatNaira(payments.reduce((sum, row) => sum + (Number(row.amount) || 0), 0))}
                        </span>
                        {Number(debt.amount_paid) > 0 && (
                          <>
                            {' · '}
                            <span className="money">{formatNaira(debt.amount_paid)}</span> before tracking
                          </>
                        )}
                      </p>
                    )}
                    {!debt.settled && debt.monthly_payment > 0 && (() => {
                      const payoff = payoffProjection(debt, debt.monthly_payment, undefined, paid)
                      if (!payoff) return null
                      return (
                        <p className="text-[11px] text-muted">
                          {payoff.monthsRemaining === 0 ? (
                            'Paid off'
                          ) : (
                            <>
                              Paid off in {payoff.monthsRemaining} month{payoff.monthsRemaining === 1 ? '' : 's'} at{' '}
                              <span className="money">{formatNaira(debt.monthly_payment)}</span>/mo ·{' '}
                              {formatDate(payoff.payoffDate)}
                            </>
                          )}
                        </p>
                      )
                    })()}
                  </div>
                )}

                {/* Dates */}
                {(debt.due_date || debt.payout_date) && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 pt-3 border-t border-white/5">
                    {debt.due_date && (
                      <p className={`text-[11px] ${dueIn < 0 ? 'text-red-400' : 'text-muted'}`}>
                        Due {formatDate(debt.due_date)}
                        {dueIn != null && !debt.settled && (
                          <span className="ml-1">
                            ({dueIn < 0 ? `${Math.abs(dueIn)}d overdue` : dueIn === 0 ? 'today' : `in ${dueIn}d`})
                          </span>
                        )}
                      </p>
                    )}
                    {debt.payout_date && (
                      <p className="text-[11px] text-blue-400">
                        Payout {formatDate(debt.payout_date)}
                        {payoutIn != null && payoutIn >= 0 && !debt.settled && (
                          <span className="ml-1">(in {payoutIn}d)</span>
                        )}
                      </p>
                    )}
                  </div>
                )}

                {debt.notes && <p className="text-[11px] text-muted mt-2 italic">{debt.notes}</p>}

                <div className="mt-3 flex gap-2">
                  {/* A repayment is an ordinary QuickLog entry with the
                      category and note filled in and the row linked back
                      here. Loans only: a rotating cycle pays by round. */}
                  {linkLive && !debt.settled && !isRotating(debt.kind) && (
                    <button
                      onClick={() => openQuickLog(repayingType(debt), { debt })}
                      className="flex-1 py-2.5 text-xs font-bold rounded-xl bg-accent/15 hover:bg-accent/25 text-accent min-h-[44px] transition-colors"
                    >
                      {debt.direction === 'owed_to_me' ? 'Log a repayment' : 'Log payment'}
                    </button>
                  )}
                  <button
                    onClick={() => toggleSettled(debt)}
                    className="flex-1 py-2.5 text-xs font-semibold rounded-xl bg-white/5 hover:bg-white/10 text-muted hover:text-white min-h-[44px] transition-colors"
                  >
                    {debt.settled ? 'Reopen' : 'Mark settled'}
                  </button>
                </div>

                {confirmDeleteId === debt.id && (
                  <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                    <p className="text-xs text-red-400 mb-2">Delete this permanently?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleDelete(debt.id)}
                        className="flex-1 py-2.5 bg-red-500 text-white text-xs font-bold rounded-lg min-h-[44px]"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="flex-1 py-2.5 bg-white/5 text-muted text-xs font-bold rounded-lg min-h-[44px]"
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

      {/* Add / Edit */}
      <Sheet
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? 'Edit debt' : 'New debt'}
        desktopCenter
      >
        <form
          onSubmit={handleSave}
          className={`p-6 space-y-4 overflow-y-auto ${shake ? 'animate-shake' : ''}`}
        >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">{editing ? 'Edit' : 'New'}</h2>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                aria-label="Close"
                className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-muted hover:text-white"
              >
                ✕
              </button>
            </div>

            {formError && (
              <p role="alert" className="text-xs text-red-400 font-medium">
                {formError}
              </p>
            )}

            {/* Kind */}
            <div>
              <label className="block text-xs text-muted font-semibold mb-2">Type</label>
              <div className="grid grid-cols-3 gap-2">
                {KINDS.map(k => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setForm({ ...form, kind: k.value })}
                    className={`px-3 py-3 rounded-xl border text-xs font-semibold min-h-[48px] transition-all ${
                      form.kind === k.value
                        ? 'border-accent bg-accent/10 text-accent'
                        : 'border-white/10 bg-background text-muted'
                    }`}
                  >
                    {k.icon} {k.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Direction — a rotating cycle has no single direction */}
            {!rotating && (
              <div>
                <label className="block text-xs text-muted font-semibold mb-2">Direction</label>
                <div className="grid grid-cols-2 gap-2">
                  {DIRECTIONS.map(d => (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => setForm({ ...form, direction: d.value })}
                      className={`px-3 py-3 rounded-xl border text-xs font-semibold min-h-[48px] transition-all ${
                        form.direction === d.value
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-white/10 bg-background text-muted'
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs text-muted font-semibold mb-1">
                {rotating ? 'Group or organiser' : 'Who'}
              </label>
              <input
                value={form.counterparty}
                onChange={(e) => setForm({ ...form, counterparty: e.target.value })}
                placeholder={rotating ? 'Office ajo' : 'Name'}
                required
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>

            {rotating ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-muted font-semibold mb-1">Rounds in cycle</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      value={form.cycle_size}
                      onChange={(e) => setForm({ ...form, cycle_size: e.target.value })}
                      placeholder="12"
                      className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted font-semibold mb-1">Current round</label>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      value={form.cycle_position}
                      onChange={(e) => setForm({ ...form, cycle_position: e.target.value })}
                      placeholder="4"
                      className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-muted font-semibold mb-1">Contribution per round (₦)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={form.contribution}
                    onChange={(e) => setForm({ ...form, contribution: e.target.value })}
                    placeholder="20000"
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
                  />
                </div>

                <div>
                  <label className="block text-xs text-muted font-semibold mb-1">Your payout date</label>
                  <input
                    type="date"
                    value={form.payout_date}
                    onChange={(e) => setForm({ ...form, payout_date: e.target.value })}
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
                  />
                </div>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-muted font-semibold mb-1">Amount (₦)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={form.principal}
                    onChange={(e) => setForm({ ...form, principal: e.target.value })}
                    placeholder="50000"
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted font-semibold mb-1">
                    {linkLive ? 'Paid before tracking (₦)' : 'Paid so far (₦)'}
                  </label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={form.amount_paid}
                    onChange={(e) => setForm({ ...form, amount_paid: e.target.value })}
                    placeholder="0"
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
                  />
                  {linkLive && (
                    <p className="text-[10px] text-muted-dim mt-1">
                      Payments logged from the card are added on top of this.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Optional, and only for a real balance -- a rotating cycle pays
                by round, not by a monthly amount toward a total. */}
            {!rotating && hasColumn('debts.monthly_payment') && (
              <div>
                <label className="block text-xs text-muted font-semibold mb-1">
                  Planned monthly payment (₦, optional)
                </label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={form.monthly_payment}
                  onChange={(e) => setForm({ ...form, monthly_payment: e.target.value })}
                  placeholder="10000"
                  className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
                />
                <p className="text-[10px] text-muted-dim mt-1">
                  Set this to see a projected payoff date on the card below.
                </p>
              </div>
            )}

            <div>
              <label className="block text-xs text-muted font-semibold mb-1">
                {rotating ? 'Next contribution due' : 'Due date'}
              </label>
              <input
                type="date"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>

            <div>
              <label className="block text-xs text-muted font-semibold mb-1">Notes</label>
              <input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Optional"
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>

            <button
              type="submit"
              disabled={saving || justSaved}
              className="w-full py-3.5 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50 flex items-center justify-center"
            >
              {justSaved ? (
                <span className="inline-block text-lg animate-check-pop" aria-hidden="true">✓</span>
              ) : saving ? (
                'Saving…'
              ) : editing ? (
                'Save changes'
              ) : (
                'Add'
              )}
            </button>
        </form>
      </Sheet>
    </div>
  )
}
