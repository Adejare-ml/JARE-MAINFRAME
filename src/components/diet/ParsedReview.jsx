import { useState } from 'react'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { scaleItem } from '../../lib/diet/parse'
import { sumNutrition, round1, toNumber } from '../../lib/diet/nutrition'
import { mealVerdict } from '../../lib/diet/verdict'
import { SLOTS, SLOT_LABELS, SLOT_ICONS, slotForHour, localHour } from '../../lib/diet/totals'
import { logMeal, applyPantry } from './api'
import VerdictBadge from './VerdictBadge'

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
        confirmBuzz()
        toast.success(`${Number(res?.kcal ?? totals.kcal).toLocaleString()} kcal logged ✓`)
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
      toast.success(`${parts.join(', ')} ✓`)
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
    <div className="space-y-4" aria-label="Check the entry">
      {header}
      {text && (
        <p className="text-[11px] text-muted">
          From {source === 'voice' ? 'what you said' : source === 'photo' ? 'your note' : 'what you typed'}: <span className="text-white">"{text}"</span>
        </p>
      )}

      {entry.question && (
        <p className="rounded-xl border border-orange-400/30 bg-orange-400/10 px-3 py-2 text-xs text-orange-200" role="note">
          {entry.question}
        </p>
      )}

      {items.length > 0 && (
        <section aria-label="Food" className="space-y-2">
          <ul className="space-y-2">
            {items.map((it, i) => (
              <li key={it.key ?? i} className={`rounded-2xl border p-3 ${it.flagged && !it.edited ? 'border-orange-400/40 bg-orange-400/5' : 'border-white/10 bg-background/50'}`}>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-white truncate">
                      {it.name}
                      {it.hidden && <span className="text-[10px] text-muted font-normal"> (hidden)</span>}
                    </p>
                    <p className="text-[11px] text-muted tabular-nums">
                      {it.kcal} kcal · {round1(it.protein_g)} g protein
                      {it.source === 'saved' ? ' · saved meal' : it.source === 'free' ? '' : ' · from your foods'}
                    </p>
                  </div>
                  <button type="button" onClick={() => remove(i)} className="w-10 h-10 rounded-full text-muted hover:text-red-300" aria-label={`Remove ${it.name}`}>
                    ✕
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2">
                  <button type="button" onClick={() => step(i, -1)} className="w-12 h-11 rounded-xl bg-white/5 border border-white/10 text-white text-lg" aria-label={`Less ${it.name}`}>
                    −
                  </button>
                  <span className="flex-1 text-center text-sm font-bold text-white tabular-nums" aria-live="polite">
                    {it.recipe_id && it.portions ? `${round1(it.portions)} portion${it.portions === 1 ? '' : 's'} · ` : ''}
                    {round1(it.grams)} g
                  </span>
                  <button type="button" onClick={() => step(i, 1)} className="w-12 h-11 rounded-xl bg-white/5 border border-white/10 text-white text-lg" aria-label={`More ${it.name}`}>
                    +
                  </button>
                </div>
                {it.flagged && !it.edited && <p className="text-[11px] text-orange-300 mt-2">{it.flag_reason}</p>}
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Meal">
            {SLOTS.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={slot === s}
                onClick={() => setSlot(s)}
                className={`min-h-[44px] rounded-xl border text-[11px] font-bold ${slot === s ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 text-muted'}`}
              >
                <span aria-hidden="true">{SLOT_ICONS[s]}</span> {SLOT_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-white tabular-nums">
              {totals.kcal.toLocaleString()} kcal · {totals.protein_g} g protein
            </span>
            <VerdictBadge verdict={preview.verdict} />
          </div>
          {preview.reason && <p className="text-[11px] text-muted leading-relaxed">{preview.reason}</p>}
        </section>
      )}

      {pantry.length > 0 && (
        <section aria-label="Pantry" className="space-y-1">
          <p className="text-[11px] font-semibold text-muted uppercase tracking-wider">Pantry</p>
          {pantry.map((u, i) => (
            <label key={i} className="flex items-center gap-3 min-h-[44px] text-sm text-white">
              <input
                type="checkbox"
                checked={u.keep}
                onChange={(e) => setPantry((list) => list.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))}
                className="w-5 h-5 accent-[var(--color-accent)]"
              />
              <span>
                {PANTRY_WORDS[u.action]} {u.quantity != null ? `${u.quantity} ${u.unit || ''} ` : ''}
                {u.name}
                {u.cost_naira != null ? ` for ₦${u.cost_naira.toLocaleString()}` : ''}
              </span>
            </label>
          ))}
        </section>
      )}

      {nothing && <p className="text-sm text-muted">Nothing to log from that note. Try again with what you ate, or pick foods by hand.</p>}

      <div className="grid grid-cols-[auto_1fr] gap-2">
        <button type="button" onClick={onBack} className="px-4 min-h-[52px] rounded-xl bg-white/5 text-white text-sm font-bold">
          {backLabel}
        </button>
        <button type="button" onClick={confirm} disabled={busy || nothing} className="min-h-[52px] rounded-xl bg-accent text-black font-extrabold text-sm disabled:opacity-50">
          {busy ? 'Saving…' : 'Looks right'}
        </button>
      </div>
    </div>
  )
}
