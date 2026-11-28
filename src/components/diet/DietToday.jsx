import { useState } from 'react'
import ProgressRing from '../ui/ProgressRing'
import EmptyState from '../ui/EmptyState'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Label from '../ui/Label'
import Button, { buttonClasses } from '../ui/Button'
import IconButton from '../ui/IconButton'
import Icon from '../ui/Icon'
import StatusDot from '../ui/StatusDot'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { dayTotals, remaining, SLOTS, SLOT_LABELS, localTime, slotForHour, localHour, normaliseSlot } from '../../lib/diet/totals'
import { sumNutrition, round1 } from '../../lib/diet/nutrition'
import { priceItems, logMeal, deleteMeal, isSealedPhotoMeal } from './api'
import VerdictBadge from './VerdictBadge'
// Phase 4: the coach and the target review.
import WhatNext from './WhatNext'
import TargetReviewCard from './TargetReviewCard'
import { patternFlag } from '../../lib/diet/coach'
import { targetReview } from '../../lib/diet/target'
import { hasColumn } from '../../lib/schema'

/**
 * Today: what is left, one-tap saved meals, and the meals so far.
 *
 * A saved meal logs on a single tap, with an Undo on the toast rather than
 * a confirmation first: the spec's "a saved meal logs in one tap" is a
 * done-criterion, and a wrong tap costs one more tap to take back.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
export default function DietToday({ lib, logs, onChanged, onAdd, onOpenSettings, onPhoto, onCheck, recent = [], latestWeight = null }) {
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
      toast.success(`${saved.name}: ${Number(res.kcal).toLocaleString()} kcal`, {
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

  // Phase 4: a pattern over the last days, worked out in code, and the
  // 14-day target review when it is due.
  const flag = patternFlag(recent, settings)
  const review = targetReview({ settings, latestWeight })

  const kcalColor = left.over ? 'var(--color-danger)' : left.kcal_ratio != null && left.kcal_ratio >= 0.85 ? 'var(--color-warn)' : 'var(--color-accent)'

  return (
    <div className="space-y-3">
      <Panel label="Today's numbers" meta={`${totals.count} meal${totals.count === 1 ? '' : 's'}`}>
        <div className="grid grid-cols-2 gap-3">
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
            color={left.protein_met ? 'var(--color-accent)' : 'var(--color-muted)'}
            big={left.protein_left == null || left.protein_met ? `${totals.protein_g}` : `${left.protein_left}`}
            unit={left.protein_left == null ? 'g eaten' : left.protein_met ? 'g, target met' : 'g to go'}
            sub={settings?.protein_target_g ? `${totals.protein_g} of ${settings.protein_target_g} g` : 'No target set'}
          />
        </div>
        {(!settings?.kcal_target || !settings?.protein_target_g) && (
          <div className="mt-3">
            <Button variant="ghost" size="sm" full onClick={onOpenSettings}>
              Set your targets in Diet settings
            </Button>
          </div>
        )}

        {/* Phase 3: the camera is one tap from here; Add food holds the rest. */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className={`${buttonClasses({ variant: 'primary', full: true })} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent`}>
            <Icon name="camera" size={18} /> Snap
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) onPhoto?.(f)
              }}
            />
          </label>
          <Button variant="secondary" icon="plus" full onClick={onAdd}>
            Add food
          </Button>
        </div>
      </Panel>

      {lib.saved.length > 0 && (
        <Panel label="One tap" meta={`${lib.saved.length} saved`} flush>
          <ListRows>
            {lib.saved.map((s) => {
              const n = sumNutrition(priceItems(s.items, lib))
              return (
                <ListRow
                  key={s.id}
                  onClick={logging != null ? undefined : () => logSaved(s)}
                  label={`Log ${s.name}, ${n.kcal} kcal`}
                  title={logging === s.id ? 'Logging…' : s.name}
                  subtitle={`${n.kcal.toLocaleString()} kcal · ${n.protein_g} g protein`}
                  trailing={<Icon name="plus" size={18} className="text-muted" />}
                />
              )
            })}
          </ListRows>
        </Panel>
      )}

      {review && settings?.kcal_target && <TargetReviewCard review={review} current={settings.kcal_target} onDecided={onChanged} />}
      {flag && (
        <Panel label="Pattern" tone="warn" role="note">
          <p className="text-body-sm text-foreground">{flag}</p>
        </Panel>
      )}
      {hasColumn('meal_logs.coach') && <WhatNext />}

      <Panel label="Today's meals" meta={logs.length ? `${totals.kcal.toLocaleString()} kcal` : undefined} flush>
        {logs.length === 0 ? (
          <EmptyState title="Nothing logged today" message="Tap a saved meal above, or add what you ate." actionLabel="Add food" onAction={onAdd} />
        ) : (
          <div className="divide-y divide-border">
            {SLOTS.filter((s) => totals.bySlot[s].kcal > 0 || logs.some((l) => normaliseSlot(l.meal_slot) === s)).map((s) => (
              <div key={s}>
                <div className="flex items-center justify-between gap-3 px-3 min-h-9 bg-surface-2 border-b border-border">
                  <Label as="h3">{SLOT_LABELS[s]}</Label>
                  <span className="type-data text-muted-dim whitespace-nowrap">{totals.bySlot[s].kcal.toLocaleString()} kcal</span>
                </div>
                <ul className="divide-y divide-border">
                  {logs
                    .filter((l) => normaliseSlot(l.meal_slot) === s)
                    .map((m) => (
                      <li key={m.id}>
                        <ListRow
                          title={(m.meal_items || []).map((i) => i.name).join(', ') || 'Meal'}
                          subtitle={`${localTime(m.eaten_at)} · ${round1(m.protein_g)} g protein${m.source === 'saved' ? ' · one tap' : ''}`}
                          trailing={
                            <>
                              {/* Phase 3: a photo meal the owner has not checked yet. */}
                              {m.status === 'auto' ? (
                                <Button size="sm" variant="secondary" onClick={() => onCheck?.(m)}>
                                  <StatusDot status="warn" /> Check
                                </Button>
                              ) : (
                                <VerdictBadge verdict={m.verdict} />
                              )}
                              <span className="text-body font-medium text-foreground tabular-nums whitespace-nowrap">{Number(m.kcal).toLocaleString()}</span>
                              {/* 054: a photo reading is final, so it has no delete. */}
                              {isSealedPhotoMeal(m) ? null : confirmDelete === m.id ? (
                                <Button size="sm" variant="danger" onClick={() => remove(m.id)}>
                                  Delete?
                                </Button>
                              ) : (
                                <IconButton name="close" label="Delete this meal" onClick={() => askDelete(m.id)} className="-mr-3" />
                              )}
                            </>
                          }
                        />
                        {m.reason && <p className="px-3 pb-3 -mt-1 text-body-sm text-muted">{m.reason}</p>}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}

function Ring({ label, ratio, color, big, unit, sub }) {
  return (
    <div className="flex flex-col items-center text-center min-w-0">
      <ProgressRing value={ratio ?? 0} size={104} strokeWidth={6} color={color}>
        <div>
          <p className="text-figure text-foreground tabular-nums whitespace-nowrap">{big}</p>
          <p className="text-body-sm text-muted">{unit}</p>
        </div>
      </ProgressRing>
      <Label as="p" className="mt-2">{label}</Label>
      <p className="type-data text-muted-dim">{sub}</p>
    </div>
  )
}
