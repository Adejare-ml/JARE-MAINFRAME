import { useState } from 'react'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { scaleItem } from '../../lib/diet/parse'
import { sumNutrition, round1, toNumber } from '../../lib/diet/nutrition'
import { mealVerdict } from '../../lib/diet/verdict'
import { SLOTS, SLOT_LABELS, slotForHour, localHour } from '../../lib/diet/totals'
import { logMeal, applyPantry, coachMeal } from './api'
import { needsCoach } from '../../lib/diet/coach'
import { hasColumn } from '../../lib/schema'
import VerdictBadge from './VerdictBadge'
import { SheetBox } from './parts'
import Button from '../ui/Button'
import IconButton from '../ui/IconButton'
import Icon from '../ui/Icon'
import Money from '../ui/Money'
import Segmented from '../ui/Segmented'

const PANTRY_WORDS = { bought: 'Bought', finished: 'Finished', used: 'Used' }

/**
 * The entry the parser read, pre-filled: one tap on "Looks right", or the
 * steppers first. Flagged items (not in the foods list, or a guessed
 * amount) come first with the reason, and the parser's one question, if it
 * asked one, sits at the top.
 *
 * Grams step by a tenth of the item (at least 5 g); a recipe item steps by
 * half a portion. Every change is re-priced in the browser with the same
 * code the database uses (scaleItem in src/lib/diet/parse.js), and the
 * database prices it again on insert.
 *
 * The meal and the pantry updates are confirmed together but saved apart
 * (log_diet_meal, apply_pantry_updates), each idempotent, so a failure in
 * one does not lose the other.
 *
 * Added for the Diet module, Phase 2 (docs/diet-module.md).
 *
 * Phase 3 reuses it for photo meals, which are already in the log as
 * 'auto': `onConfirm(items, {slot, verdict, reason, edited})` replaces the
 * logging step (it confirms the existing meal instead), `header` shows the
 * photo and how each model did, and `backLabel` names what Back does there
 * ("Discard"). Without those props it behaves exactly as in Phase 2.
 */
export default function ParsedReview({ entry, text, source, lib, todayLogs = [], onDone, onBack, onConfirm = null, header = null, backLabel = 'Back' }) {
  const [items, setItems] = useState(entry.items)
  const [pantry, setPantry] = useState(() => entry.pantry.map((u) => ({ ...u, keep: true })))
  const [slot, setSlot] = useState(entry.meal_slot || slotForHour(localHour()))
  const [busy, setBusy] = useState(false)
  const totals = sumNutrition(items)
  const preview = mealVerdict({ settings: lib.settings, slot, meal: totals, earlier: todayLogs })
  const keptPantry = pantry.filter((u) => u.keep)

  const step = (i, dir) =>
    setItems((list) =>
      list.map((it, j) => {
        if (j !== i) return it
        if (it.recipe_id && it.portions) {
          const per = it.grams / it.portions
          const next = Math.max(0.5, Math.min(20, it.portions + dir * 0.5))
          return { ...scaleItem(it, per * next, lib), edited: true }
        }
        const g = toNumber(it.grams) || 0
        const delta = Math.max(5, Math.round(g / 10 / 5) * 5)
        return { ...scaleItem(it, Math.max(0, g + dir * delta), lib), edited: true }
      }),
    )

  const remove = (i) => setItems((list) => list.filter((_, j) => j !== i))

  const confirm = async () => {
    setBusy(true)
    let logged = null
    if (onConfirm) {
      try {
        const res = await onConfirm(items, { slot, verdict: preview.verdict, reason: preview.reason, edited: items.some((i) => i.edited) || items.length !== entry.items.length })
        // Phase 4: the coach's verdict, in the background.
        if (res?.id && needsCoach({ source }) && hasColumn('meal_logs.coach')) coachMeal(res.id)
        confirmBuzz()
        toast.success(`${Number(res?.kcal ?? totals.kcal).toLocaleString()} kcal logged`)
        onDone?.(res)
      } catch (err) {
        toast.error('Not saved: ' + (err.message || 'check connection'))
      } finally {
        setBusy(false)
      }
      return
    }
    try {
      if (items.length > 0) {
        logged = await logMeal({
          items,
          slot,
          source,
          settings: lib.settings,
          todayLogs,
          savedMealId: entry.saved_meal_id,
          rawText: text,
        })
      }
      // Phase 4: the coach's verdict for a meal from a note or a voice note,
      // in the background; the verdict computed in code is already stored.
      if (logged?.id && needsCoach({ source }) && hasColumn('meal_logs.coach')) coachMeal(logged.id)
      if (keptPantry.length > 0) {
        await applyPantry(
          keptPantry.map(({ keep: _keep, ...u }) => u),
          text,
        )
      }
      confirmBuzz()
      const parts = []
      if (logged) parts.push(`${Number(logged.kcal).toLocaleString()} kcal logged`)
      if (keptPantry.length) parts.push(`pantry updated (${keptPantry.length})`)
      toast.success(`${parts.join(', ')}`)
      onDone?.(logged)
    } catch (err) {
      toast.error((logged ? 'Meal logged, but the pantry was not updated: ' : 'Not saved: ') + (err.message || 'check connection'))
      if (logged) onDone?.(logged)
    } finally {
      setBusy(false)
    }
  }

  const nothing = items.length === 0 && keptPantry.length === 0

  return (
    <div className="space-y-3" aria-label="Check the entry">
      {header}
      {text && (
        <p className="text-body-sm text-muted">
          From {source === 'voice' ? 'what you said' : source === 'photo' ? 'your note' : 'what you typed'}: <span className="text-foreground">"{text}"</span>
        </p>
      )}

      {entry.question && (
        <p className="flex items-start gap-2 rounded-panel border border-border border-l-2 border-l-warn bg-card px-3 py-2 text-body-sm text-foreground" role="note">
          <Icon name="info" size={16} className="shrink-0 mt-0.5 text-warn" />
          <span>{entry.question}</span>
        </p>
      )}

      {items.length > 0 && (
        <section aria-label="Food" className="space-y-3">
          <SheetBox label="Food" meta={`${items.length} item${items.length === 1 ? '' : 's'}`} ariaLabel="Items">
            <ul className="divide-y divide-border">
              {items.map((it, i) => {
                const flagged = it.flagged && !it.edited
                return (
                  <li key={it.key ?? i} className={`pl-3 py-2 ${flagged ? 'border-l-2 border-l-warn' : ''}`}>
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-body text-foreground truncate">
                          {it.name}
                          {it.hidden && <span className="text-body-sm text-muted"> (hidden)</span>}
                        </p>
                        <p className="text-body-sm text-muted tabular-nums">
                          {it.kcal} kcal · {round1(it.protein_g)} g protein
                          {it.source === 'saved' ? ' · saved meal' : it.source === 'free' ? '' : ' · from your foods'}
                        </p>
                      </div>
                      <IconButton name="close" label={`Remove ${it.name}`} onClick={() => remove(i)} />
                    </div>
                    <div className="flex items-center gap-2 mt-1 pr-3">
                      {/* No minus glyph in Icon yet (requested); a real minus sign, labelled. */}
                      <Button variant="secondary" aria-label={`Less ${it.name}`} onClick={() => step(i, -1)} className="w-12 px-0 text-title">
                        {'\u2212'}
                      </Button>
                      <span className="flex-1 text-center text-heading text-foreground tabular-nums" aria-live="polite">
                        {it.recipe_id && it.portions ? `${round1(it.portions)} portion${it.portions === 1 ? '' : 's'} · ` : ''}
                        {round1(it.grams)} g
                      </span>
                      <IconButton name="plus" label={`More ${it.name}`} variant="secondary" onClick={() => step(i, 1)} />
                    </div>
                    {flagged && <p className="text-body-sm text-warn mt-1 pr-3">{it.flag_reason}</p>}
                  </li>
                )
              })}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-border px-3 min-h-12">
              <span className="text-heading text-foreground tabular-nums">
                {totals.kcal.toLocaleString()} kcal · {totals.protein_g} g protein
              </span>
              <VerdictBadge verdict={preview.verdict} />
            </div>
            {preview.reason && <p className="px-3 pb-3 text-body-sm text-muted">{preview.reason}</p>}
          </SheetBox>
          <Segmented label="Meal" full options={SLOTS.map((s) => ({ value: s, label: SLOT_LABELS[s] }))} value={slot} onChange={setSlot} />
        </section>
      )}

      {pantry.length > 0 && (
        <SheetBox label="Pantry" meta={`${pantry.filter((u) => u.keep).length} of ${pantry.length}`}>
          <div className="divide-y divide-border">
            {pantry.map((u, i) => (
              <label key={i} className="flex items-center gap-3 min-h-12 px-3 text-body text-foreground">
                <input
                  type="checkbox"
                  checked={u.keep}
                  onChange={(e) => setPantry((list) => list.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))}
                  className="w-5 h-5 accent-accent shrink-0"
                />
                <span className="min-w-0">
                  {PANTRY_WORDS[u.action]} {u.quantity != null ? `${u.quantity} ${u.unit || ''} ` : ''}
                  {u.name}
                  {u.cost_naira != null && (
                    <>
                      {' for '}
                      <Money amount={u.cost_naira} kobo={false} />
                    </>
                  )}
                </span>
              </label>
            ))}
          </div>
        </SheetBox>
      )}

      {nothing && <p className="text-body-sm text-muted">Nothing to log from that note. Try again with what you ate, or pick foods by hand.</p>}

      <div className="grid grid-cols-[auto_1fr] gap-2">
        <Button variant="secondary" onClick={onBack}>
          {backLabel}
        </Button>
        <Button onClick={confirm} disabled={nothing} loading={busy}>
          {busy ? 'Saving…' : 'Looks right'}
        </Button>
      </div>
    </div>
  )
}
