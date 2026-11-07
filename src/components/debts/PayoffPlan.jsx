import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { formatNaira, formatDate } from '../../lib/formatters'
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
      toast.success('Monthly debt budget saved ✓')
    } catch (err) {
      toast.error('Could not save: ' + (err.message || 'check connection'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bg-card rounded-3xl p-5 border border-white/5 space-y-4" aria-labelledby="payoff-plan-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="payoff-plan-heading" className="text-xs font-semibold text-muted uppercase tracking-wider">
          Payoff plan
        </h2>
        <span className="text-[11px] text-muted">
          <span className="money">{formatNaira(plan.totalOutstanding)}</span> owed
        </span>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <label className="flex-1 min-w-0">
          <span className="sr-only">Monthly amount toward debts</span>
          <input
            type="number"
            inputMode="numeric"
            min="0"
            step="500"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="Monthly amount toward debts"
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
          />
        </label>
        <button
          type="button"
          onClick={saveBudget}
          disabled={saving || budget === saved}
          className="px-4 py-3 bg-white/5 text-white text-sm font-semibold rounded-xl min-h-[48px] disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div role="group" aria-label="Payoff order" className="grid grid-cols-2 gap-2">
        {PAYOFF_STRATEGIES.map((s) => (
          <button
            key={s.value}
            type="button"
            aria-pressed={strategy === s.value}
            onClick={() => setStrategy(s.value)}
            className={`px-3 py-2.5 rounded-xl text-xs font-semibold border min-h-[48px] transition-all ${
              strategy === s.value ? 'bg-accent/20 border-accent text-accent' : 'bg-background border-white/5 text-muted hover:text-white'
            }`}
          >
            {s.label}
            <span className="block text-[10px] font-normal opacity-80">{s.hint}</span>
          </button>
        ))}
      </div>

      {!plan.feasible ? (
        <p className="text-xs text-orange-300 leading-relaxed">
          No plan yet: {plan.reason}.
          {plan.minimums > 0 && (
            <>
              {' '}
              The payments you have set come to <span className="money">{formatNaira(plan.minimums)}</span> a month.
            </>
          )}
        </p>
      ) : (
        <ol className="space-y-2" aria-label="Debts in payoff order">
          {plan.order.map((item, index) => (
            <li key={item.debt.id} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-white">
                <span className="text-muted tabular-nums mr-2">{index + 1}.</span>
                {item.debt.counterparty}
                <span className="text-muted"> · <span className="money">{formatNaira(item.outstanding)}</span></span>
              </span>
              <span className="text-xs text-muted shrink-0 tabular-nums">
                {item.monthsRemaining} mo · {formatDate(item.payoffDate)}
              </span>
            </li>
          ))}
          <li className="pt-2 border-t border-white/5 text-xs text-muted">
            Debt-free in {plan.months} month{plan.months === 1 ? '' : 's'} at{' '}
            <span className="money text-white">{formatNaira(plan.budget)}</span>/mo
            {!ordersDiffer && plan.order.length > 1 && ' · same order either way'}
          </li>
        </ol>
      )}
    </section>
  )
}
