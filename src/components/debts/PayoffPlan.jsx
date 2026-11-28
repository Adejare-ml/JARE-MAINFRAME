import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { formatDate } from '../../lib/formatters'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Money from '../ui/Money'
import Button from '../ui/Button'
import Segmented from '../ui/Segmented'
import StatusDot from '../ui/StatusDot'
import { Input } from '../ui/Field'
import { planPayoff, PAYOFF_STRATEGIES } from '../../lib/debts'

/** The user_settings key the monthly debt budget is kept under. */
export const PAYOFF_BUDGET_KEY = 'debt_payoff_budget'

/**
 * When every loan I owe reaches zero, at one monthly amount.
 *
 * The single-debt projection on each card answers "when is this one done
 * at its own payment"; this answers the question the owner actually has
 * with more than one loan: in what order, and when is the last one gone.
 * Pure arithmetic in src/lib/debts.js (planPayoff); this component holds
 * the budget and the toggle and persists the budget like the calorie
 * target, under one user_settings row.
 *
 * @param {{debts: object[], paidByDebt: Record<string, number>}} props
 */
export default function PayoffPlan({ debts, paidByDebt }) {
  const [budget, setBudget] = useState('')
  const [saved, setSaved] = useState('')
  const [strategy, setStrategy] = useState('snowball')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    supabase
      .from('user_settings')
      .select('value')
      .eq('key', PAYOFF_BUDGET_KEY)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data?.value) return
        setBudget(String(data.value))
        setSaved(String(data.value))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const plan = useMemo(() => planPayoff(debts, Number(budget) || 0, strategy, { paidByDebt }), [debts, budget, strategy, paidByDebt])
  const alternative = useMemo(
    () => planPayoff(debts, Number(budget) || 0, strategy === 'snowball' ? 'avalanche' : 'snowball', { paidByDebt }),
    [debts, budget, strategy, paidByDebt],
  )
  const ordersDiffer = plan.order.map((o) => o.debt.id).join() !== alternative.order.map((o) => o.debt.id).join()

  if (plan.totalOutstanding <= 0) return null

  const saveBudget = async () => {
    const num = Number(budget)
    if (!Number.isFinite(num) || num < 0) {
      toast.error('Enter a monthly amount')
      return
    }
    setSaving(true)
    try {
      const now = new Date().toISOString()
      const { data: existing } = await supabase.from('user_settings').select('id').eq('key', PAYOFF_BUDGET_KEY).maybeSingle()
      const { error } = existing
        ? await supabase.from('user_settings').update({ value: String(num), updated_at: now }).eq('id', existing.id)
        : await supabase.from('user_settings').insert({ key: PAYOFF_BUDGET_KEY, value: String(num), updated_at: now })
      if (error) throw error
      setSaved(String(num))
      toast.success('Monthly debt budget saved')
    } catch (err) {
      toast.error('Could not save: ' + (err.message || 'check connection'))
    } finally {
      setSaving(false)
    }
  }

  const hint = PAYOFF_STRATEGIES.find((s) => s.value === strategy)?.hint

  return (
    <Panel label="Payoff plan" meta={<><Money amount={plan.totalOutstanding} kobo={false} tone="muted" className="font-normal" /> owed</>} flush>
      <div className="p-3 lg:p-4 space-y-3 border-b border-border">
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0">
            <Input
              label="Monthly amount toward debts"
              type="number"
              inputMode="numeric"
              min="0"
              step="500"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="50000"
            />
          </div>
          <Button variant="secondary" onClick={saveBudget} loading={saving} disabled={budget === saved}>
            Save
          </Button>
        </div>

        <div className="space-y-1.5">
          <Segmented
            full
            label="Payoff order"
            options={PAYOFF_STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
            value={strategy}
            onChange={setStrategy}
          />
          {hint && <p className="text-body-sm text-muted">Pays the {hint}.</p>}
        </div>
      </div>

      {!plan.feasible ? (
        <p className="flex items-start gap-2.5 p-3 lg:p-4 text-body-sm text-foreground">
          <StatusDot status="warn" className="mt-1.5" />
          <span>
            No plan yet: {plan.reason}.
            {plan.minimums > 0 && (
              <>
                {' '}
                The payments you have set come to <Money amount={plan.minimums} kobo={false} /> a month.
              </>
            )}
          </span>
        </p>
      ) : (
        <>
          <ListRows as="ol" label="Debts in payoff order">
            {plan.order.map((item, index) => (
              <ListRow
                key={item.debt.id}
                as="li"
                leading={<span className="type-data text-muted-dim w-5 text-right">{index + 1}</span>}
                title={item.debt.counterparty}
                subtitle={<Money amount={item.outstanding} tone="muted" className="font-normal" />}
                trailing={
                  <span className="type-data text-muted whitespace-nowrap">
                    {item.monthsRemaining} mo · {formatDate(item.payoffDate)}
                  </span>
                }
              />
            ))}
          </ListRows>
          <p className="px-3 py-3 lg:px-4 border-t border-border text-body-sm text-muted">
            Debt-free in {plan.months} month{plan.months === 1 ? '' : 's'} at{' '}
            <Money amount={plan.budget} kobo={false} />/mo
            {!ordersDiffer && plan.order.length > 1 && ', same order either way'}
          </p>
        </>
      )}
    </Panel>
  )
}
