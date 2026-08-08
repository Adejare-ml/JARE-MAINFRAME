import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatNaira, formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
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
} from '../lib/debts'

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
  notes: '',
}

export default function Debts() {
  const [debts, setDebts] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [tab, setTab] = useState('all')

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const fetchDebts = useCallback(async () => {
    try {
      setPageError(null)
      const { data, error } = await supabase
        .from('debts')
        .select('*')
        .order('settled', { ascending: true })
        .order('created_at', { ascending: false })

      if (error) throw error
      setDebts(data || [])
    } catch (err) {
      console.error('Error loading debts:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchDebts()
  }, [fetchDebts])

  useRealtimeRefresh(['debts'], fetchDebts, { channelPrefix: 'debts' })

  const totals = useMemo(() => debtTotals(debts), [debts])

  const visible = debts.filter(d => {
    if (tab === 'all') return true
    if (tab === 'rotating') return isRotating(d.kind)
    return d.direction === tab && !isRotating(d.kind)
  })

  const openAdd = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowModal(true)
  }

  const openEdit = (debt) => {
    setEditing(debt)
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
      notes: debt.notes || '',
    })
    setShowModal(true)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.counterparty.trim()) {
      toast.error('Who is this with?')
      return
    }

    const rotating = isRotating(form.kind)
    const num = (v) => (v === '' ? null : Number(v))

    if (rotating && form.cycle_size !== '' && form.cycle_position !== '') {
      if (Number(form.cycle_position) > Number(form.cycle_size)) {
        toast.error(`Round ${form.cycle_position} is past the end of a ${form.cycle_size}-round cycle`)
        return
      }
    }

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
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      }

      const { error } = editing
        ? await supabase.from('debts').update(payload).eq('id', editing.id)
        : await supabase.from('debts').insert(payload)
      if (error) throw error

      toast.success(editing ? 'Updated ✓' : 'Added ✓')
      setShowModal(false)
      fetchDebts()
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
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-10 bg-white/5 rounded-xl w-48" />
        <div className="h-24 bg-card rounded-3xl border border-white/5" />
        <div className="h-44 bg-card rounded-3xl border border-white/5" />
      </div>
    )
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
          <p className="text-lg font-bold text-red-400 tabular-nums">{formatNaira(totals.iOwe)}</p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Owed to me</p>
          <p className="text-lg font-bold text-accent tabular-nums">{formatNaira(totals.owedToMe)}</p>
        </div>
        <div className="bg-card rounded-2xl p-4 border border-white/5">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">In cycles</p>
          <p className="text-lg font-bold text-blue-400 tabular-nums">{formatNaira(totals.inCycles)}</p>
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
        <div className="bg-card rounded-3xl p-12 border border-white/5 text-center space-y-3">
          <span className="text-4xl block" aria-hidden="true">🤝</span>
          <p className="text-base font-bold text-white">Nothing here yet</p>
          <p className="text-xs text-muted max-w-xs mx-auto">
            Track a loan, or an ajo cycle so you know which round you're in and when the
            pot reaches you.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map(debt => {
            const cycle = cycleStatus(debt)
            const progress = repaymentProgress(debt)
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
                        {formatNaira(cycle.contributed)} in
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
                      {debt.contribution ? ` · ${formatNaira(debt.contribution)} each` : ''}
                      {cycle.expectedPot ? ` · pot ${formatNaira(cycle.expectedPot)}` : ''}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <p className="text-lg font-bold text-white tabular-nums">
                        {formatNaira(outstanding(debt))}
                      </p>
                      {Number(debt.principal) > 0 && (
                        <p className="text-xs text-muted tabular-nums">
                          of {formatNaira(debt.principal)}
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

                <button
                  onClick={() => toggleSettled(debt)}
                  className="mt-3 w-full py-2.5 text-xs font-semibold rounded-xl bg-white/5 hover:bg-white/10 text-muted hover:text-white min-h-[44px] transition-colors"
                >
                  {debt.settled ? 'Reopen' : 'Mark settled'}
                </button>

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
      {showModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <form
            onSubmit={handleSave}
            className="bg-card w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl border border-white/10 p-6 space-y-4 max-h-[90vh] overflow-y-auto"
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
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
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
                      className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
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
                      className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
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
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
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
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted font-semibold mb-1">Paid so far (₦)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={form.amount_paid}
                    onChange={(e) => setForm({ ...form, amount_paid: e.target.value })}
                    placeholder="0"
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
                  />
                </div>
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
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/50 focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full py-3.5 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
            >
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Add'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
