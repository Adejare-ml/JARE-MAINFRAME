import { useState } from 'react'
import ProgressRing from '../ui/ProgressRing'
import EmptyState from '../ui/EmptyState'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { dayTotals, remaining, SLOTS, SLOT_LABELS, SLOT_ICONS, localTime, slotForHour, localHour, normaliseSlot } from '../../lib/diet/totals'
import { sumNutrition, round1 } from '../../lib/diet/nutrition'
import { priceItems, logMeal, deleteMeal } from './api'
import VerdictBadge from './VerdictBadge'

/**
 * Today: what is left, one-tap saved meals, and the meals so far.
 *
 * A saved meal logs on a single tap, with an Undo on the toast rather than
 * a confirmation first: the spec's "a saved meal logs in one tap" is a
 * done-criterion, and a wrong tap costs one more tap to take back.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
export default function DietToday({ lib, logs, onChanged, onAdd, onOpenSettings }) {
  const [logging, setLogging] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const settings = lib.settings
  const totals = dayTotals(logs)
  const left = remaining(totals, settings)

  const logSaved = async (saved) => {
    setLogging(saved.id)
    try {
      const items = priceItems(saved.items, lib)
      if (items.length === 0) throw new Error('This saved meal names foods that no longer exist')
      const slot = saved.meal_slot || slotForHour(localHour())
      const res = await logMeal({ items, slot, source: 'saved', settings, todayLogs: logs, savedMealId: saved.id })
      confirmBuzz()
      toast.success(`${saved.name}: ${Number(res.kcal).toLocaleString()} kcal ✓`, {
        action: res.id ? { label: 'Undo', onClick: () => remove(res.id, true) } : null,
      })
      onChanged()
    } catch (err) {
      toast.error('Not logged: ' + (err.message || 'check connection'))
    } finally {
      setLogging(null)
    }
  }

  const askDelete = (id) => {
    setConfirmDelete(id)
    setTimeout(() => setConfirmDelete((c) => (c === id ? null : c)), 4000)
  }

  const remove = async (id, silent = false) => {
    try {
      await deleteMeal(id)
      if (!silent) toast.success('Meal removed')
    } catch (err) {
      toast.error('Could not delete: ' + err.message)
    }
    setConfirmDelete(null)
    onChanged()
  }

  const kcalColor = left.over ? '#f87171' : left.kcal_ratio != null && left.kcal_ratio >= 0.85 ? '#fdba74' : 'var(--color-accent)'

  return (
    <div className="space-y-6">
      <section className="bg-card rounded-3xl p-6 border border-white/10 shadow-xl" aria-label="Today's numbers">
        <div className="grid grid-cols-2 gap-4">
          <Ring
            label="Calories"
            ratio={left.kcal_ratio}
            color={kcalColor}
            big={left.kcal_left == null ? totals.kcal.toLocaleString() : Math.abs(left.kcal_left).toLocaleString()}
            unit={left.kcal_left == null ? 'kcal eaten' : left.over ? 'kcal over' : 'kcal left'}
            sub={settings?.kcal_target ? `${totals.kcal.toLocaleString()} of ${settings.kcal_target.toLocaleString()}` : 'No target set'}
          />
          <Ring
            label="Protein"
            ratio={left.protein_ratio}
            color={left.protein_met ? 'var(--color-accent)' : '#60a5fa'}
            big={left.protein_left == null ? `${totals.protein_g}` : left.protein_met ? '✓' : `${left.protein_left}`}
            unit={left.protein_left == null ? 'g eaten' : left.protein_met ? 'target met' : 'g to go'}
            sub={settings?.protein_target_g ? `${totals.protein_g} of ${settings.protein_target_g} g` : 'No target set'}
          />
        </div>
        {(!settings?.kcal_target || !settings?.protein_target_g) && (
          <button type="button" onClick={onOpenSettings} className="mt-4 w-full text-xs font-bold text-accent min-h-[44px]">
            Set your targets in Diet settings →
          </button>
        )}

        <button type="button" onClick={onAdd} className="mt-4 w-full flex items-center justify-center gap-2 bg-accent text-black font-extrabold text-sm rounded-xl min-h-[52px] hover:bg-accent/90">
          <span aria-hidden="true">＋</span> Add food
        </button>

        {lib.saved.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">One tap</p>
            <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
              {lib.saved.map((s) => {
                const n = sumNutrition(priceItems(s.items, lib))
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => logSaved(s)}
                    disabled={logging != null}
                    className="shrink-0 text-left px-3 py-2 rounded-2xl bg-white/5 border border-white/10 hover:border-accent/50 min-h-[52px] disabled:opacity-60 max-w-[240px]"
                    aria-label={`Log ${s.name}, ${n.kcal} kcal`}
                  >
                    <span className="block text-xs font-bold text-white truncate">{logging === s.id ? 'Logging…' : s.name}</span>
                    <span className="block text-[10px] text-muted tabular-nums">
                      {n.kcal} kcal · {n.protein_g} g protein
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4" aria-label="Today's meals">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Today's meals</h2>
        {logs.length === 0 ? (
          <EmptyState icon="🍽️" title="Nothing logged today" message="Tap a saved meal above, or add what you ate." actionLabel="Add food" onAction={onAdd} />
        ) : (
          SLOTS.filter((s) => totals.bySlot[s].kcal > 0 || logs.some((l) => normaliseSlot(l.meal_slot) === s)).map((s) => (
            <div key={s} className="space-y-2">
              <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                <span aria-hidden="true">{SLOT_ICONS[s]}</span> {SLOT_LABELS[s]} · {totals.bySlot[s].kcal.toLocaleString()} kcal
              </p>
              <ul className="space-y-2">
                {logs
                  .filter((l) => normaliseSlot(l.meal_slot) === s)
                  .map((m) => (
                    <li key={m.id} className="p-3 rounded-2xl bg-background/40 border border-white/5">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-white truncate">{(m.meal_items || []).map((i) => i.name).join(', ') || 'Meal'}</p>
                          <p className="text-[11px] text-muted">
                            {localTime(m.eaten_at)} · {round1(m.protein_g)} g protein{m.source === 'saved' ? ' · one tap' : ''}
                          </p>
                        </div>
                        <VerdictBadge verdict={m.verdict} />
                        <span className="text-sm font-bold text-white tabular-nums shrink-0">{Number(m.kcal).toLocaleString()}</span>
                        {confirmDelete === m.id ? (
                          <button type="button" onClick={() => remove(m.id)} className="shrink-0 px-3 rounded-xl bg-red-500/20 text-red-300 text-xs font-bold min-h-[48px]">
                            Delete?
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => askDelete(m.id)}
                            className="shrink-0 rounded-full bg-white/5 hover:bg-red-500/20 text-muted hover:text-red-300 text-sm min-h-[48px] min-w-[48px]"
                            aria-label="Delete this meal"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                      {m.reason && <p className="text-[11px] text-muted mt-2 leading-relaxed">{m.reason}</p>}
                    </li>
                  ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </div>
  )
}

function Ring({ label, ratio, color, big, unit, sub }) {
  return (
    <div className="flex flex-col items-center text-center">
      <ProgressRing value={ratio ?? 0} size={112} strokeWidth={9} color={color}>
        <div>
          <p className="text-xl font-extrabold text-white tabular-nums leading-none">{big}</p>
          <p className="text-[10px] text-muted mt-1">{unit}</p>
        </div>
      </ProgressRing>
      <p className="text-xs font-semibold text-muted uppercase tracking-wider mt-2">{label}</p>
      <p className="text-[11px] text-muted-dim tabular-nums">{sub}</p>
    </div>
  )
}
