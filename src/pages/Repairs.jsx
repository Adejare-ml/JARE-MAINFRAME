import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import Sheet from '../components/ui/Sheet'
import { RepairsSkeleton } from '../components/ui/PageSkeleton'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import Stat from '../components/ui/Stat'
import Readout from '../components/ui/Readout'
import Money from '../components/ui/Money'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Button from '../components/ui/Button'
import IconButton from '../components/ui/IconButton'
import Segmented from '../components/ui/Segmented'
import StatusDot from '../components/ui/StatusDot'
import Icon from '../components/ui/Icon'
import { Field, Input } from '../components/ui/Field'
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
      toast.success(editing ? 'Updated' : 'Added')
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
      <div className="space-y-3 pb-6">
        <PageHeader title="Repairs" />
        <Panel label="Setup needed" tone="warn">
          <p className="flex items-start gap-2 text-body-sm text-foreground">
            <StatusDot status="warn" className="mt-1.5" />
            <span>
              Run <code className="type-data">supabase/migrations/027_repairs.sql</code> in the Supabase SQL editor to switch
              this page on.
            </span>
          </p>
        </Panel>
      </div>
    )
  }

  if (pageError) {
    return (
      <div className="space-y-3">
        <PageHeader title="Repairs" />
        <ErrorState message={pageError} onRetry={fetchRepairs} />
      </div>
    )
  }

  return (
    <div className="space-y-3 pb-6">
      <PageHeader
        title="Repairs"
        meta="Repairs and maintenance"
        actions={
          <Button icon="plus" onClick={openAdd}>
            Add
          </Button>
        }
      />

      <Segmented
        full
        label="Filter by priority"
        options={[{ value: 'all', label: 'All' }, ...PRIORITIES].map((p) => ({ value: p.value, label: p.label }))}
        value={priority}
        onChange={setPriority}
      />

      <Panel label="Status">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Pending" value={counts.pending} />
          <Stat label="In progress" value={counts.inProgress} />
          <Stat label="Done" value={counts.done} />
        </div>
      </Panel>

      {visible.length === 0 ? (
        <Panel label="Queue">
          <EmptyState
            title={priority === 'all' ? 'No repairs tracked' : 'Nothing at this priority'}
            message={
              priority === 'all'
                ? 'Add the things that need fixing or maintenance, with a rough cost, so they stop living in your head'
                : 'Try another priority, or add a repair'
            }
            actionLabel="Add repair"
            onAction={openAdd}
          />
        </Panel>
      ) : (
        <Panel label="Queue" meta={`${visible.length} item${visible.length === 1 ? '' : 's'}`} flush>
          <ListRows label="Repair queue">
            {visible.map((repair) => {
              const done = repair.status === 'done'
              const overdue = !done && repair.due_date && repair.due_date < today
              const priorityMeta = PRIORITIES.find((p) => p.value === repair.priority)
              const statusMeta = STATUSES.find((s) => s.value === repair.status)
              const classification = CLASSIFICATIONS.find((c) => c.value === repair.classification)

              return (
                <div key={repair.id}>
                  <ListRow
                    leading={<StatusDot status={done ? 'muted' : priorityMeta?.tone || 'muted'} />}
                    title={<span className={done ? 'text-muted line-through' : ''}>{repair.item}</span>}
                    subtitle={[priorityMeta?.label || repair.priority, statusMeta?.label, classification?.label || repair.classification]
                      .filter(Boolean)
                      .join(' · ')}
                    trailing={Number(repair.estimated_cost) > 0 && <Money amount={Number(repair.estimated_cost)} />}
                  />
                  {repair.due_date && (
                    <p className={`type-data pl-8 pr-3 -mt-1 pb-1 ${overdue ? 'text-danger' : 'text-muted-dim'}`}>
                      {overdue ? 'Overdue, was due ' : 'Due '}
                      {formatDate(repair.due_date)}
                    </p>
                  )}
                  {repair.notes && <p className="text-body-sm text-muted pl-8 pr-3 pb-2">{repair.notes}</p>}
                  <div className="flex items-center gap-1 pl-8 pr-1 pb-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={done ? 'undo' : repair.status === 'pending' ? 'play' : 'check'}
                      onClick={() => advance(repair)}
                      className="flex-1"
                    >
                      {done ? 'Reopen' : repair.status === 'pending' ? 'Start' : 'Mark done'}
                    </Button>
                    <IconButton name="edit" label={`Edit ${repair.item}`} onClick={() => openEdit(repair)} />
                    <IconButton name="trash" label={`Delete ${repair.item}`} onClick={() => setConfirmDeleteId(repair.id)} />
                  </div>

                  {confirmDeleteId === repair.id && (
                    <div role="alert" className="space-y-2 pl-8 pr-3 pb-3">
                      <p className="flex items-center gap-2 text-body-sm text-danger">
                        <StatusDot status="danger" />
                        Delete this permanently?
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <Button variant="danger" size="sm" icon="trash" onClick={() => handleDelete(repair.id)}>
                          Delete
                        </Button>
                        <Button variant="secondary" size="sm" onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </ListRows>
        </Panel>
      )}

      <Panel label="Cost estimate">
        <Readout
          label="Still ahead"
          value={costs.openEstimate}
          sub={
            costs.allEstimate > costs.openEstimate ? (
              <>
                Including what is done: <Money amount={costs.allEstimate} />
              </>
            ) : undefined
          }
        />
      </Panel>

      {/* Add / Edit */}
      <Sheet isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit repair' : 'New repair'} desktopCenter>
        <form onSubmit={handleSave} className={`p-4 space-y-4 overflow-y-auto ${shake ? 'animate-shake' : ''}`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-title text-foreground">{editing ? 'Edit repair' : 'New repair'}</h2>
            <IconButton name="close" label="Close" onClick={() => setShowModal(false)} className="-mr-3" />
          </div>

          {formError && (
            <p role="alert" className="flex items-center gap-2 text-body-sm text-danger">
              <StatusDot status="danger" />
              {formError}
            </p>
          )}

          <Input
            label="What needs fixing"
            value={form.item}
            onChange={(e) => setForm({ ...form, item: e.target.value })}
            placeholder="Generator service"
            required
          />

          <Field label="Priority">
            {() => (
              <Segmented
                full
                label="Priority"
                options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))}
                value={form.priority}
                onChange={(value) => setForm({ ...form, priority: value })}
              />
            )}
          </Field>

          <Field label="Need or want">
            {() => (
              <Segmented
                full
                label="Need or want"
                options={[{ value: '', label: 'Not set' }, ...CLASSIFICATIONS]}
                value={form.classification}
                onChange={(value) => setForm({ ...form, classification: value })}
              />
            )}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Estimate, naira"
              type="number"
              inputMode="decimal"
              min="0"
              value={form.estimated_cost}
              onChange={(e) => setForm({ ...form, estimated_cost: e.target.value })}
              placeholder="15000"
            />
            <Input label="Due by" type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
          </div>

          <Input
            label="Notes"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            placeholder="Optional"
          />

          <Button type="submit" full loading={saving} disabled={justSaved}>
            {justSaved ? (
              <>
                <span className="inline-flex animate-check-pop" aria-hidden="true">
                  <Icon name="check" size={20} />
                </span>
                <span className="sr-only">Saved</span>
              </>
            ) : saving ? (
              'Saving…'
            ) : editing ? (
              'Save changes'
            ) : (
              'Add'
            )}
          </Button>
        </form>
      </Sheet>
    </div>
  )
}
