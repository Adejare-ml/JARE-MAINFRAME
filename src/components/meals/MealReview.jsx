import { useState } from 'react'
import {
  itemCalories,
  sumCalories,
  sumMacros,
  withQuantity,
  stepQuantity,
  quantityLabel,
  newItem,
  MEAL_TYPES,
  MEAL_TYPE_ICONS,
  LIMITS,
} from '../../lib/meals'
import { NIGERIAN_ANCHORS, GENERAL_ANCHORS } from '../../lib/mealPrompt'

/**
 * The step between "the model said" and "logged": every dish on its own
 * row with a quantity stepper, a remove control, and a way to add what the
 * model missed, from the same dish list the prompt is built from.
 *
 * Quantities scale from the figure the model gave, never from the current
 * value, so ¾ then back to 1 lands exactly where it started (see
 * withQuantity). Nothing here talks to the network; the parent logs.
 */

const ALL_DISHES = [...NIGERIAN_ANCHORS, ...GENERAL_ANCHORS]

/** The dishes whose name contains every word typed, best (shortest) first. */
export function searchDishes(query, max = 8) {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return []
  return ALL_DISHES.filter(([name]) => {
    const n = name.toLowerCase()
    return words.every((w) => n.includes(w))
  })
    .sort((a, b) => a[0].length - b[0].length)
    .slice(0, max)
}

/** One band for the plate: the worst confidence among the items that carry most of its calories. */
export function overallConfidence(items) {
  const list = (items || []).filter((i) => i && i.name)
  if (list.length === 0) return 'medium'
  const total = sumCalories(list) || 1
  let worst = 'high'
  const rank = { high: 0, medium: 1, low: 2 }
  for (const item of list) {
    // An item under a tenth of the plate does not drag the whole plate down.
    if (itemCalories(item) / total < 0.1 && list.length > 1) continue
    if (rank[item.confidence] > rank[worst]) worst = item.confidence
  }
  return worst
}

const BAND = {
  high: { text: 'Confident reading', cls: 'text-accent' },
  medium: { text: 'Fair estimate; adjust a portion if it looks off', cls: 'text-muted' },
  low: { text: 'Rough guess; check the portions', cls: 'text-orange-300' },
}

export default function MealReview({
  items,
  onItemsChange,
  mealType,
  onMealTypeChange,
  note,
  onNoteChange,
  eatenOn,
  today,
  onEatenOnChange,
  advice,
  qualityNote,
}) {
  const [query, setQuery] = useState('')
  const [customName, setCustomName] = useState('')
  const [customKcal, setCustomKcal] = useState('')

  const total = sumCalories(items)
  const macros = sumMacros(items)
  const band = BAND[overallConfidence(items)]
  const matches = searchDishes(query)

  const update = (id, patch) => onItemsChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  const remove = (id) => onItemsChange(items.filter((i) => i.id !== id))
  const add = (item) => {
    if (items.length >= LIMITS.items) return
    onItemsChange([...items, item])
  }

  const addDish = ([name, portion, kcal]) => {
    add(newItem({ name, portion, calories: kcal, confidence: 'high', quantity: 1 }))
    setQuery('')
  }

  const addCustom = (e) => {
    e.preventDefault()
    const kcal = parseInt(customKcal, 10)
    if (!customName.trim() || !Number.isFinite(kcal) || kcal < 0) return
    add(newItem({ name: customName, portion: '1 serving', calories: kcal, confidence: 'medium', quantity: 1 }))
    setCustomName('')
    setCustomKcal('')
  }

  return (
    <div className="space-y-5">
      {/* The total, first: it is the number being decided. */}
      <div className="bg-background border border-white/10 rounded-2xl p-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-muted font-semibold uppercase tracking-wider">This meal</p>
          <p className="text-3xl font-extrabold text-white tabular-nums">
            {total.toLocaleString()} <span className="text-base font-bold text-muted">kcal</span>
          </p>
          {macros && (
            <p className="text-[11px] text-muted-dim mt-0.5">
              P {macros.protein_g} g · C {macros.carbs_g} g · F {macros.fat_g} g
            </p>
          )}
        </div>
        <p className={`text-[11px] font-semibold text-right max-w-[45%] ${band.cls}`}>{band.text}</p>
      </div>

      {(qualityNote || advice) && (
        <p className="text-[11px] text-muted-dim leading-relaxed">
          {qualityNote}
          {qualityNote && advice ? ' ' : ''}
          {advice}
        </p>
      )}

      {/* The dishes */}
      <ul className="space-y-2" aria-label="Dishes in this meal">
        {items.map((item) => (
          <li key={item.id} className="bg-white/5 border border-white/5 rounded-2xl p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">
                  {item.name}
                  {item.confidence === 'low' && (
                    <span className="ml-1 text-orange-300" title="The model was unsure about this one" aria-label="uncertain">
                      ?
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-muted truncate">
                  {item.portion || 'portion as seen'}
                  {item.note ? ` · ${item.note}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => remove(item.id)}
                className="shrink-0 w-9 h-9 rounded-full bg-white/5 hover:bg-red-500/20 text-muted hover:text-red-300 flex items-center justify-center text-sm min-h-[48px] min-w-[48px]"
                aria-label={`Remove ${item.name}`}
              >
                ✕
              </button>
            </div>
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-1" role="group" aria-label={`Portion of ${item.name}`}>
                <button
                  type="button"
                  onClick={() => update(item.id, withQuantity(item, stepQuantity(item.quantity, -1)))}
                  className="w-10 h-10 rounded-xl bg-background border border-white/10 text-white font-bold min-h-[48px] min-w-[48px]"
                  aria-label="Less"
                >
                  −
                </button>
                <span className="w-12 text-center text-sm font-bold text-white tabular-nums">{quantityLabel(item.quantity)}</span>
                <button
                  type="button"
                  onClick={() => update(item.id, withQuantity(item, stepQuantity(item.quantity, +1)))}
                  className="w-10 h-10 rounded-xl bg-background border border-white/10 text-white font-bold min-h-[48px] min-w-[48px]"
                  aria-label="More"
                >
                  +
                </button>
              </div>
              <span className="text-sm font-bold text-white tabular-nums">{itemCalories(item).toLocaleString()} kcal</span>
            </div>
          </li>
        ))}
        {items.length === 0 && <li className="text-xs text-muted text-center py-3">Nothing on the plate yet. Add a dish below.</li>}
      </ul>

      {/* Add what the model missed */}
      <div className="space-y-2">
        <label htmlFor="meal-add-dish" className="block text-xs font-medium text-muted">
          Add a dish
        </label>
        <input
          id="meal-add-dish"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="eba, moi moi, Coke…"
          className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
        />
        {matches.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" aria-label="Matching dishes">
            {matches.map((row) => (
              <li key={row[0]}>
                <button
                  type="button"
                  onClick={() => addDish(row)}
                  className="w-full text-left px-3 py-2.5 rounded-xl bg-white/5 hover:bg-accent/15 border border-white/5 min-h-[48px]"
                >
                  <span className="block text-sm font-semibold text-white">{row[0]}</span>
                  <span className="block text-[11px] text-muted">
                    {row[1]} · {row[2]} kcal
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() && matches.length === 0 && (
          <form onSubmit={addCustom} className="flex gap-2">
            <input
              type="text"
              value={customName || query}
              onChange={(e) => setCustomName(e.target.value)}
              aria-label="Dish name"
              className="flex-1 min-w-0 px-3 py-2.5 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[48px]"
            />
            <input
              type="number"
              inputMode="numeric"
              min="0"
              value={customKcal}
              onChange={(e) => setCustomKcal(e.target.value)}
              placeholder="kcal"
              aria-label="Calories"
              className="w-24 px-3 py-2.5 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[48px]"
            />
            <button type="submit" className="px-4 rounded-xl bg-accent text-black font-bold text-sm min-h-[48px]">
              Add
            </button>
          </form>
        )}
      </div>

      {/* Which meal, and when */}
      <div>
        <p className="text-xs font-medium text-muted mb-1">Meal</p>
        <div role="group" aria-label="Meal type" className="grid grid-cols-4 gap-2">
          {MEAL_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => onMealTypeChange(t)}
              aria-pressed={mealType === t}
              className={`py-2.5 rounded-xl border text-xs font-bold capitalize min-h-[48px] transition-all ${
                mealType === t ? 'bg-accent/20 border-accent text-white' : 'bg-white/5 border-white/5 text-muted hover:text-white'
              }`}
            >
              <span aria-hidden="true">{MEAL_TYPE_ICONS[t]}</span> {t}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="meal-date" className="block text-xs font-medium text-muted mb-1">
            Date
          </label>
          <input
            id="meal-date"
            type="date"
            value={eatenOn}
            max={today}
            onChange={(e) => onEatenOnChange(e.target.value)}
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
          />
        </div>
        <div>
          <label htmlFor="meal-note" className="block text-xs font-medium text-muted mb-1">
            Note
          </label>
          <input
            id="meal-note"
            type="text"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            maxLength={200}
            placeholder="where, with whom…"
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
          />
        </div>
      </div>
    </div>
  )
}
