import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { toast } from '../lib/toast'
import { formatDate } from '../lib/formatters'
import ErrorState from '../components/ui/ErrorState'
import EmptyState from '../components/ui/EmptyState'
import Sheet from '../components/ui/Sheet'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import Button from '../components/ui/Button'
import IconButton from '../components/ui/IconButton'
import Icon from '../components/ui/Icon'
import Badge from '../components/ui/Badge'
import Money from '../components/ui/Money'
import Stat from '../components/ui/Stat'
import Readout from '../components/ui/Readout'
import ProgressBar from '../components/ui/ProgressBar'
import Segmented from '../components/ui/Segmented'
import StatusDot from '../components/ui/StatusDot'
import Label from '../components/ui/Label'
import { Input } from '../components/ui/Field'
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
import PayoffPlan from '../components/debts/PayoffPlan'

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
  match_payee: '',
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
      match_payee: debt.match_payee || '',
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
        // The payee as the bank prints it; the ingest function links any
        // alert in the repaying direction that carries it (039).
        ...(hasColumn('debts.match_payee') ? { match_payee: form.match_payee.trim() || null } : {}),
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      }

      const { error } = editing
        ? await supabase.from('debts').update(payload).eq('id', editing.id)
        : await supabase.from('debts').insert(payload)
      if (error) throw error

      confirmBuzz()
      toast.success(editing ? 'Updated' : 'Added')
      fetchDebts()

      // A brief check glyph before the sheet closes, rather than it vanishing
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
      toast.success(debt.settled ? 'Reopened' : 'Marked settled')
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
      <div className="space-y-3 pb-6">
        <PageHeader title="Debts" meta="Loans, ajo and esusu" />
        <ErrorState message={pageError} onRetry={fetchDebts} />
      </div>
    )
  }

  const rotating = isRotating(form.kind)
  const setField = (patch) => setForm({ ...form, ...patch })
  const tabMeta = TABS.find((t) => t.value === tab) || TABS[0]

  return (
    <div className="space-y-3 pb-6">
      <PageHeader
        title="Debts"
        meta="Loans, ajo and esusu"
        actions={
          <Button size="sm" icon="plus" onClick={openAdd}>
            New
          </Button>
        }
      />

      {/* Totals */}
      <Panel label="Totals">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="I owe" value={<Money amount={totals.iOwe} kobo={false} />} />
          <Stat label="Owed to me" value={<Money amount={totals.owedToMe} kobo={false} tone={totals.owedToMe > 0 ? 'positive' : 'default'} />} />
          <Stat label="In cycles" value={<Money amount={totals.inCycles} kobo={false} />} />
        </div>
      </Panel>

      {/* In what order, and when the last loan is gone. Renders nothing
          while nothing is owed. */}
      <PayoffPlan debts={debts} paidByDebt={paidByDebt} />

      {/* Tabs */}
      <Segmented
        tabs
        full
        idPrefix="debts"
        label="Debts filters"
        options={TABS}
        value={tab}
        onChange={setTab}
      />

      {/* List */}
      <div id={`debts-panel-${tab}`} role="tabpanel" aria-labelledby={`debts-tab-${tab}`}>
        <Panel
          label={tabMeta.title || tabMeta.label}
          meta={visible.length > 0 ? `${visible.length} ${visible.length === 1 ? 'entry' : 'entries'}` : null}
          flush
        >
          {visible.length === 0 ? (
            <EmptyState
              title={tab === 'all' ? 'Nothing here yet' : 'Nothing in this tab'}
              message={
                tab === 'all'
                  ? "Track a loan, or an ajo cycle so you know which round you're in and when the pot reaches you"
                  : 'Try a different tab, or add a debt'
              }
              actionLabel="New debt"
              onAction={openAdd}
            />
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((debt) => {
                const cycle = cycleStatus(debt)
                const paid = paidByDebt[debt.id]
                const payments = linkedPayments(linkedRows, debt)
                const progress = repaymentProgress(debt, paid)
                const dueIn = daysUntil(debt.due_date)
                const payoutIn = daysUntil(debt.payout_date)
                const kindMeta = KINDS.find((k) => k.value === debt.kind)

                return (
                  <li key={debt.id} className="px-3 py-3 lg:px-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 mt-0.5 rounded-chip bg-surface-2 text-muted shrink-0">
                        <Icon name={kindMeta?.icon || 'debt'} size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className={`text-heading truncate ${debt.settled ? 'text-muted' : 'text-foreground'}`}>{debt.counterparty}</h3>
                          {debt.settled && <Badge label="Settled" />}
                        </div>
                        <p className="text-body-sm text-muted">
                          {kindMeta?.label}
                          {!isRotating(debt.kind) && ` · ${DIRECTIONS.find((d) => d.value === debt.direction)?.label}`}
                        </p>
                      </div>
                      <div className="flex -mr-3 -my-1.5 shrink-0">
                        <IconButton name="edit" label={`Edit ${debt.counterparty}`} onClick={() => openEdit(debt)} />
                        <IconButton name="trash" label={`Delete ${debt.counterparty}`} onClick={() => setConfirmDeleteId(debt.id)} />
                      </div>
                    </div>

                    {/* Rotating savings: the part the ledger cannot tell you */}
                    {cycle ? (
                      <div className="space-y-2">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="text-heading text-foreground">
                            Round {cycle.position} of {cycle.size}
                          </p>
                          <p className="text-body-sm text-muted whitespace-nowrap">
                            <Money amount={cycle.contributed} /> in
                          </p>
                        </div>
                        <ProgressBar value={cycle.position} max={cycle.size} label={`Round ${cycle.position} of ${cycle.size}`} />
                        <p className="text-body-sm text-muted">
                          {cycle.roundsLeft === 0
                            ? 'Final round'
                            : `${cycle.roundsLeft} round${cycle.roundsLeft === 1 ? '' : 's'} to go`}
                          {debt.contribution && (
                            <>
                              {' · '}
                              <Money amount={debt.contribution} tone="muted" /> each
                            </>
                          )}
                          {cycle.expectedPot && (
                            <>
                              {' · pot '}
                              <Money amount={cycle.expectedPot} tone="muted" />
                            </>
                          )}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Readout
                          label="Outstanding"
                          value={outstanding(debt, paid)}
                          tone={debt.settled ? 'muted' : 'default'}
                          sub={
                            Number(debt.principal) > 0 ? (
                              <>
                                of <Money amount={debt.principal} tone="muted" />
                              </>
                            ) : null
                          }
                        />
                        {progress != null && (
                          <ProgressBar value={progress * 100} label={`${Math.round(progress * 100)}% repaid`} />
                        )}
                        {payments.length > 0 && (
                          <p className="text-body-sm text-muted">
                            {payments.length} payment{payments.length === 1 ? '' : 's'} from the ledger ·{' '}
                            <Money
                              amount={payments.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)}
                              tone="muted"
                            />
                            {Number(debt.amount_paid) > 0 && (
                              <>
                                {' · '}
                                <Money amount={debt.amount_paid} tone="muted" /> before tracking
                              </>
                            )}
                          </p>
                        )}
                        {!debt.settled && debt.monthly_payment > 0 && (() => {
                          const payoff = payoffProjection(debt, debt.monthly_payment, undefined, paid)
                          if (!payoff) return null
                          return (
                            <p className="text-body-sm text-muted">
                              {payoff.monthsRemaining === 0 ? (
                                'Paid off'
                              ) : (
                                <>
                                  Paid off in {payoff.monthsRemaining} month{payoff.monthsRemaining === 1 ? '' : 's'} at{' '}
                                  <Money amount={debt.monthly_payment} tone="muted" />/mo ·{' '}
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
                      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2.5 border-t border-border">
                        {debt.due_date && (
                          <p className={`type-data flex items-center gap-2 ${dueIn < 0 && !debt.settled ? 'text-danger' : 'text-muted'}`}>
                            {dueIn < 0 && !debt.settled && <StatusDot status="danger" />}
                            Due {formatDate(debt.due_date)}
                            {dueIn != null && !debt.settled && (
                              <span>
                                ({dueIn < 0 ? `${Math.abs(dueIn)}d overdue` : dueIn === 0 ? 'today' : `in ${dueIn}d`})
                              </span>
                            )}
                          </p>
                        )}
                        {debt.payout_date && (
                          <p className="type-data text-muted">
                            Payout {formatDate(debt.payout_date)}
                            {payoutIn != null && payoutIn >= 0 && !debt.settled && <span> (in {payoutIn}d)</span>}
                          </p>
                        )}
                      </div>
                    )}

                    {debt.notes && <p className="text-body-sm text-muted">{debt.notes}</p>}

                    <div className="flex gap-2">
                      {/* A repayment is an ordinary QuickLog entry with the
                          category and note filled in and the row linked back
                          here. Loans only: a rotating cycle pays by round. */}
                      {linkLive && !debt.settled && !isRotating(debt.kind) && (
                        <Button size="sm" variant="secondary" icon="plus" className="flex-1" onClick={() => openQuickLog(repayingType(debt), { debt })}>
                          {debt.direction === 'owed_to_me' ? 'Log a repayment' : 'Log payment'}
                        </Button>
                      )}
                      <Button size="sm" variant="secondary" className="flex-1" onClick={() => toggleSettled(debt)}>
                        {debt.settled ? 'Reopen' : 'Mark settled'}
                      </Button>
                    </div>

                    {confirmDeleteId === debt.id && (
                      <div role="alert" className="pt-3 border-t border-border space-y-2">
                        <p className="text-body-sm text-danger">Delete this permanently?</p>
                        <div className="flex gap-2">
                          <Button variant="danger" className="flex-1" onClick={() => handleDelete(debt.id)}>
                            Delete
                          </Button>
                          <Button variant="secondary" className="flex-1" onClick={() => setConfirmDeleteId(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* Add / Edit */}
      <Sheet
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? 'Edit debt' : 'New debt'}
        desktopCenter
      >
        <form onSubmit={handleSave} className={`p-4 space-y-4 overflow-y-auto ${shake ? 'animate-shake' : ''}`}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-title text-foreground">{editing ? 'Edit debt' : 'New debt'}</h2>
            <IconButton name="close" label="Close" className="-mr-3" onClick={() => setShowModal(false)} />
          </div>

          {formError && (
            <p role="alert" className="text-body-sm text-danger">
              {formError}
            </p>
          )}

          {/* Kind */}
          <div className="space-y-1.5">
            <Label as="p">Type</Label>
            <Segmented
              full
              label="Type"
              options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
              value={form.kind}
              onChange={(kind) => setField({ kind })}
            />
          </div>

          {/* Direction: a rotating cycle has no single direction */}
          {!rotating && (
            <div className="space-y-1.5">
              <Label as="p">Direction</Label>
              <Segmented
                full
                label="Direction"
                options={DIRECTIONS.map((d) => ({ value: d.value, label: d.label }))}
                value={form.direction}
                onChange={(direction) => setField({ direction })}
              />
            </div>
          )}

          <Input
            label={rotating ? 'Group or organiser' : 'Who'}
            value={form.counterparty}
            onChange={(e) => setField({ counterparty: e.target.value })}
            placeholder={rotating ? 'Office ajo' : 'Name'}
            required
          />

          {hasColumn('debts.match_payee') && (
            <Input
              label="Payee on bank alerts (optional)"
              value={form.match_payee}
              onChange={(e) => setField({ match_payee: e.target.value })}
              placeholder={rotating ? 'As the alert names the group' : 'e.g. OKash'}
              hint={`Every ${rotating ? 'contribution' : 'repayment'} the bank reports to this payee is linked here on arrival and counts as paid.`}
            />
          )}

          {rotating ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Rounds in cycle"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={form.cycle_size}
                  onChange={(e) => setField({ cycle_size: e.target.value })}
                  placeholder="12"
                />
                <Input
                  label="Current round"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={form.cycle_position}
                  onChange={(e) => setField({ cycle_position: e.target.value })}
                  placeholder="4"
                />
              </div>

              <Input
                label="Contribution per round (naira)"
                type="number"
                inputMode="decimal"
                value={form.contribution}
                onChange={(e) => setField({ contribution: e.target.value })}
                placeholder="20000"
              />

              <Input
                label="Your payout date"
                type="date"
                value={form.payout_date}
                onChange={(e) => setField({ payout_date: e.target.value })}
              />
            </>
          ) : (
            <div className="grid grid-cols-2 gap-3 items-start">
              <Input
                label="Amount (naira)"
                type="number"
                inputMode="decimal"
                value={form.principal}
                onChange={(e) => setField({ principal: e.target.value })}
                placeholder="50000"
              />
              <Input
                label={linkLive ? 'Paid before tracking' : 'Paid so far'}
                type="number"
                inputMode="decimal"
                value={form.amount_paid}
                onChange={(e) => setField({ amount_paid: e.target.value })}
                placeholder="0"
                hint={linkLive ? 'Payments logged from the card are added on top of this.' : undefined}
              />
            </div>
          )}

          {/* Optional, and only for a real balance -- a rotating cycle pays
              by round, not by a monthly amount toward a total. */}
          {!rotating && hasColumn('debts.monthly_payment') && (
            <Input
              label="Planned monthly payment (optional)"
              type="number"
              inputMode="decimal"
              value={form.monthly_payment}
              onChange={(e) => setField({ monthly_payment: e.target.value })}
              placeholder="10000"
              hint="Set this to see a projected payoff date on the card below."
            />
          )}

          <Input
            label={rotating ? 'Next contribution due' : 'Due date'}
            type="date"
            value={form.due_date}
            onChange={(e) => setField({ due_date: e.target.value })}
          />

          <Input
            label="Notes"
            value={form.notes}
            onChange={(e) => setField({ notes: e.target.value })}
            placeholder="Optional"
          />

          <Button type="submit" full loading={saving} disabled={justSaved}>
            {justSaved ? (
              <span className="inline-flex animate-check-pop" aria-label="Saved">
                <Icon name="check" size={20} />
              </span>
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

/** The list filters; ids name the Segmented tab and its panel. `title` is the
 * full name the list panel shows when the tab label is shortened to fit 360px. */
const TABS = [
  { value: 'all', label: 'All' },
  { value: 'i_owe', label: 'I owe' },
  { value: 'owed_to_me', label: 'Lent', title: 'Owed to me' },
  { value: 'rotating', label: 'Cycles', title: 'Ajo and esusu' },
]
