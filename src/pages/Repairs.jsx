import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatNaira, formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import Sheet from '../components/ui/Sheet'
import { RepairsSkeleton } from '../components/ui/PageSkeleton'
import { confirmBuzz } from '../lib/haptics'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { hasColumn } from '../lib/schema'
import { toDateOnly } from '../lib/queries'
import {
  PRIORITIES,
  STATUSES,
  CLASSIFICATIONS,
  nextStatus,
  repairCounts,
  costTotals,
  filterRepairs,
  sortRepairs,
} from '../lib/repairs'

/**
 * The repairs and maintenance queue the README promised, on the table 027
 * heals. Same skeleton as Projects.jsx and Debts.jsx: one fetch, chips, a
 * Sheet for create/edit, inline confirm delete. The one gesture of its own
 * is the status button on each card, which walks Pending -> In progress ->
 * Done -- a repair moves through those in order, and a tap is quicker than
 * a picker.
 */

const EMPTY_FORM = {
  item: '',
  priority: 'soon',
  classification: '',
  estimated_cost: '',
  due_date: '',
  notes: '',
}

const PRIORITY_STYLE = {
  urgent: 'bg-red-500/15 text-red-300',
  soon: 'bg-blue-500/15 text-blue-300',
  someday: 'bg-white/5 text-muted',
}

export default function Repairs() {
  const available = hasColumn('repairs.user_id')

  const [repairs, setRepairs] = useState([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState(null)
  const [priority, setPriority] = useState('all')

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [formError, setFormError] = useState(null)
  const [shake, setShake] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const fetchRepairs = useCallback(async () => {
    if (!available) {
      setLoading(false)
      return
    }
    try {
      setPageError(null)
      const { data, error } = await supabase.from('repairs').select('*').order('created_at', { ascending: false })
      if (error) throw error
      setRepairs(data || [])
    } catch (err) {
      console.error('Error loading repairs:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [available])

  useEffect(() => {
    fetchRepairs()
  }, [fetchRepairs])

  useRealtimeRefresh(['repairs'], fetchRepairs, { channelPrefix: 'repairs', enabled: available })

  const counts = useMemo(() => repairCounts(repairs), [repairs])
  const costs = useMemo(() => costTotals(repairs), [repairs])
  const visible = useMemo(() => sortRepairs(filterRepairs(repairs, priority)), [repairs, priority])
  const today = toDateOnly(new Date())

  const openAdd = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setShowModal(true)
  }

  const openEdit = (repair) => {
    setEditing(repair)
    setFormError(null)
    setForm({
      item: repair.item || '',
      priority: repair.priority || 'soon',
      classification: repair.classification || '',
      estimated_cost: repair.estimated_cost != null ? String(repair.estimated_cost) : '',
      due_date: repair.due_date || '',
      notes: repair.notes || '',
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
    const item = form.item.trim()
    if (!item) {
      fail('What needs fixing?')
      return
    }
    const cost = form.estimated_cost === '' ? null : Number(form.estimated_cost)
    if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
      fail('The estimate has to be a number, zero or more')
      return
    }

    setFormError(null)
    setSaving(true)
    try {
      const payload = {
        item,
        priority: form.priority,
        classification: form.classification || null,
        estimated_cost: cost,
        due_date: form.due_date || null,
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      }
      const { error } = editing
        ? await supabase.from('repairs').update(payload).eq('id', editing.id)
        : await supabase.from('repairs').insert({ ...payload, status: 'pending' })
      if (error) throw error

      confirmBuzz()
      toast.success(editing ? 'Updated ✓' : 'Added ✓')
      fetchRepairs()
      setJustSaved(true)
      setTimeout(() => {
        setShowModal(false)
        setJustSaved(false)
      }, 220)
    } catch (err) {
      console.error('Error saving repair:', err)
      toast.error('Failed to save: ' + (err.message || 'check connection'))
    } finally {
      setSaving(false)
    }
  }

  const advance = async (repair) => {
    const status = nextStatus(repair.status)
    const { error } = await supabase
      .from('repairs')
      .update({
        status,
        completed_at: status === 'done' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', repair.id)
    if (error) toast.error('Failed to update: ' + error.message)
    else {
      if (status === 'done') confirmBuzz()
      toast.success(STATUSES.find((s) => s.value === status)?.label || status)
      fetchRepairs()
    }
  }

  const handleDelete = async (id) => {
    const { error } = await supabase.from('repairs').delete().eq('id', id)
    if (error) toast.error('Failed to delete: ' + error.message)
    else {
      toast.success('Deleted')
      setConfirmDeleteId(null)
      fetchRepairs()
    }
  }

  if (loading) return <RepairsSkeleton />

  if (!available) {
    return (
      <div className="space-y-6 pb-6">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Repairs 🔧</h1>
        <div className="rounded-2xl bg-orange-500/10 border border-orange-500/20 p-5 text-sm text-orange-300 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/027_repairs.sql</code> in the Supabase SQL editor to switch this
          page on.
        </div>
      </div>
    )
  }

  if (pageError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold text-white">Repairs 🔧</h1>
        <ErrorState message={pageError} onRetry={fetchRepairs} />
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-white">Repairs 🔧</h1>
          <p className="text-muted text-sm mt-0.5">Track repairs & maintenance needs</p>
        </div>
        <button
          onClick={openAdd}
          className="px-4 py-2.5 bg-accent text-black rounded-xl text-sm font-bold min-h-[48px] flex-shrink-0"
        >
          + Add
        </button>
      </div>

      {/* Priority chips */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {[{ value: 'all', label: 'All' }, ...PRIORITIES].map((p) => (
          <button
            key={p.value}
            onClick={() => setPriority(p.value)}
            className={`px-4 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap min-h-[48px] transition-all ${
              priority === p.value ? 'bg-accent text-black' : 'bg-card text-muted hover:text-white border border-white/5'
            }`}
          >
            {p.icon ? `${p.icon} ` : ''}
            {p.label}
          </button>
        ))}
      </div>

      {/* Status summary */}
      <div className="grid grid-cols-3 gap-3">
        {[
          ['Pending', counts.pending, 'text-yellow-500'],
          ['In progress', counts.inProgress, 'text-blue-400'],
          ['Done', counts.done, 'text-accent'],
        ].map(([label, value, color]) => (
          <div key={label} className="bg-card rounded-2xl p-4 border border-white/5 text-center">
            <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
            <p className="text-xs text-muted mt-1">{label}</p>
          </div>
        ))}
      </div>

      {/* Queue */}
      {visible.length === 0 ? (
        <div className="bg-card rounded-3xl border border-white/5">
          <EmptyState
            icon="🔧"
            title={priority === 'all' ? 'No repairs tracked' : 'Nothing at this priority'}
            message={
              priority === 'all'
                ? 'Add the things that need fixing or maintenance, with a rough cost, so they stop living in your head'
                : 'Try another priority, or add a repair'
            }
            actionLabel="+ Add repair"
            onAction={openAdd}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((repair) => {
            const done = repair.status === 'done'
            const overdue = !done && repair.due_date && repair.due_date < today
            const priorityMeta = PRIORITIES.find((p) => p.value === repair.priority)
            const statusMeta = STATUSES.find((s) => s.value === repair.status)

            return (
              <div
                key={repair.id}
                className={`bg-card rounded-2xl p-5 border transition-all ${done ? 'border-white/5 opacity-60' : 'border-white/10'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span aria-hidden="true">{priorityMeta?.icon || '🔧'}</span>
                      <h3 className={`text-sm font-bold truncate ${done ? 'text-muted line-through' : 'text-white'}`}>{repair.item}</h3>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full uppercase font-bold ${PRIORITY_STYLE[repair.priority] || PRIORITY_STYLE.someday}`}>
                        {priorityMeta?.label || repair.priority}
                      </span>
                      {repair.classification && (
                        <span className="text-[9px] bg-white/5 text-muted px-1.5 py-0.5 rounded-full uppercase font-bold">
                          {repair.classification}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted mt-0.5">
                      {statusMeta?.label}
                      {repair.due_date && (
                        <span className={overdue ? 'text-red-400' : ''}>
                          {' · '}
                          {overdue ? 'was due ' : 'due '}
                          {formatDate(repair.due_date)}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {Number(repair.estimated_cost) > 0 && (
                      <p className="text-sm font-bold text-white tabular-nums money mr-2">{formatNaira(repair.estimated_cost)}</p>
                    )}
                    <button
                      onClick={() => openEdit(repair)}
                      aria-label={`Edit ${repair.item}`}
                      className="w-11 h-11 flex items-center justify-center rounded-xl hover:bg-white/5 text-muted hover:text-white"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(repair.id)}
                      aria-label={`Delete ${repair.item}`}
                      className="w-11 h-11 flex items-center justify-center rounded-xl hover:bg-red-500/10 text-muted hover:text-red-400"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {repair.notes && <p className="text-[11px] text-muted mt-2 italic">{repair.notes}</p>}

                <button
                  onClick={() => advance(repair)}
                  className="mt-3 w-full py-2.5 text-xs font-semibold rounded-xl bg-white/5 hover:bg-white/10 text-muted hover:text-white min-h-[44px] transition-colors"
                >
                  {done ? 'Reopen' : repair.status === 'pending' ? 'Start' : 'Mark done'}
                </button>

                {confirmDeleteId === repair.id && (
                  <div className="mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                    <p className="text-xs text-red-400 mb-2">Delete this permanently?</p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleDelete(repair.id)}
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

      {/* Cost estimate */}
      <section className="bg-card rounded-2xl p-6 border border-white/5">
        <h2 className="text-sm font-semibold text-muted uppercase tracking-wider mb-4">Cost Estimate</h2>
        <div className="flex justify-between items-center">
          <span className="text-muted text-sm">Still ahead</span>
          <span className="text-white font-bold text-xl tabular-nums money">{formatNaira(costs.openEstimate)}</span>
        </div>
        {costs.allEstimate > costs.openEstimate && (
          <div className="flex justify-between items-center mt-2">
            <span className="text-muted-dim text-xs">Including what is done</span>
            <span className="text-muted text-sm tabular-nums money">{formatNaira(costs.allEstimate)}</span>
          </div>
        )}
      </section>

      {/* Add / Edit */}
      <Sheet isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit repair' : 'New repair'} desktopCenter>
        <form onSubmit={handleSave} className={`p-6 space-y-4 overflow-y-auto ${shake ? 'animate-shake' : ''}`}>
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

          <div>
            <label className="block text-xs text-muted font-semibold mb-1">What needs fixing</label>
            <input
              value={form.item}
              onChange={(e) => setForm({ ...form, item: e.target.value })}
              placeholder="Generator service"
              required
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
            />
          </div>

          <div>
            <label className="block text-xs text-muted font-semibold mb-2">Priority</label>
            <div className="grid grid-cols-3 gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setForm({ ...form, priority: p.value })}
                  className={`px-3 py-3 rounded-xl border text-xs font-semibold min-h-[48px] transition-all ${
                    form.priority === p.value ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 bg-background text-muted'
                  }`}
                >
                  {p.icon} {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-muted font-semibold mb-2">Need or want</label>
            <div className="grid grid-cols-2 gap-2">
              {CLASSIFICATIONS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => setForm({ ...form, classification: form.classification === c.value ? '' : c.value })}
                  aria-pressed={form.classification === c.value}
                  className={`px-3 py-3 rounded-xl border text-xs font-semibold min-h-[48px] transition-all ${
                    form.classification === c.value ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 bg-background text-muted'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-muted font-semibold mb-1">Estimated cost (₦)</label>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                value={form.estimated_cost}
                onChange={(e) => setForm({ ...form, estimated_cost: e.target.value })}
                placeholder="15000"
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>
            <div>
              <label className="block text-xs text-muted font-semibold mb-1">Due by</label>
              <input
                type="date"
                value={form.due_date}
                onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>
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
              <span className="inline-block text-lg animate-check-pop" aria-hidden="true">
                ✓
              </span>
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
