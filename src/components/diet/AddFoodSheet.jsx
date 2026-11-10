import { useEffect, useMemo, useRef, useState } from 'react'
import Sheet from '../ui/Sheet'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { searchFoods, portionOptions } from '../../lib/diet/foods'
import { sumNutrition, toNumber, round1 } from '../../lib/diet/nutrition'
import { mealVerdict } from '../../lib/diet/verdict'
import { SLOTS, SLOT_LABELS, SLOT_ICONS, slotForHour, localDay, localTime, localHour } from '../../lib/diet/totals'
import { priceItems, logMeal } from './api'
import VerdictBadge from './VerdictBadge'
// Phase 2: type or say it, then review what was read.
import DescribeFood from './DescribeFood'
import ParsedReview from './ParsedReview'
// Phase 3: a photo, read by Claude and NVIDIA (and the laptop's Ollama later).
import PhotoFlow from './PhotoFlow'
import { hasColumn } from '../../lib/schema'

const PORTION_STEPS = [0.5, 1, 1.5, 2]

/**
 * Logging a meal by hand: find a food or a recipe, say how much, repeat,
 * log. Phase 1's main way in (photo, text and voice arrive in Phases 2
 * and 3), so it is built for speed on a phone: the search box has focus
 * when the sheet opens, a food's typical portions are one tap, and the
 * meal's verdict is shown before it is logged.
 *
 * Lagos time: the time box is a Lagos clock time, turned into an instant
 * with a fixed +01:00 offset. Lagos has no daylight saving, so the offset
 * never changes.
 *
 * `mode="save"` builds a saved meal instead of logging one (Library tab).
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
export default function AddFoodSheet({ isOpen, onClose, lib, todayLogs = [], onLogged, mode = 'log', initialFile = null, checkMeal = null }) {
  const [query, setQuery] = useState('')
  const [basket, setBasket] = useState([])
  const [picking, setPicking] = useState(null)
  const [amount, setAmount] = useState('')
  const [slot, setSlot] = useState(() => slotForHour(localHour()))
  const [time, setTime] = useState(() => localTime(new Date()))
  const [saveAs, setSaveAs] = useState(mode === 'save')
  const [saveName, setSaveName] = useState('')
  const [custom, setCustom] = useState(null)
  const [busy, setBusy] = useState(false)
  const [parsed, setParsed] = useState(null)
  // Phase 3: {file} for a new photo, {meal} to check an 'auto' photo meal.
  const [photo, setPhoto] = useState(null)
  const photosReady = hasColumn('meal_estimates.answer')
  const searchRef = useRef(null)

  // A fresh sheet every time it opens: the slot and clock follow the hour.
  useEffect(() => {
    if (!isOpen) return
    setQuery('')
    setBasket([])
    setPicking(null)
    setCustom(null)
    setParsed(null)
    setPhoto(initialFile ? { file: initialFile } : checkMeal ? { meal: checkMeal } : null)
    setSaveAs(mode === 'save')
    setSaveName('')
    setSlot(slotForHour(localHour()))
    setTime(localTime(new Date()))
    const t = setTimeout(() => searchRef.current?.focus(), 50)
    return () => clearTimeout(t)
  }, [isOpen, mode, initialFile, checkMeal])

  const results = useMemo(() => (lib ? searchFoods(query, lib.foods, lib.recipes, 30) : []), [query, lib])
  const priced = useMemo(() => (lib ? priceItems(basket, lib) : []), [basket, lib])
  const totals = sumNutrition(priced)
  const preview = mealVerdict({ settings: lib?.settings, slot, meal: totals, earlier: todayLogs })

  if (!lib) return null

  const pick = (result) => {
    setPicking(result)
    if (result.kind === 'recipe') setAmount('1')
    else setAmount(String(toNumber(result.row.typical_portion_g) ?? 100))
  }

  const addPicked = () => {
    const n = toNumber(amount)
    if (!n || n <= 0) {
      toast.error(picking.kind === 'recipe' ? 'How many portions?' : 'How many grams?')
      return
    }
    const ref =
      picking.kind === 'recipe'
        ? { key: crypto.randomUUID(), recipe_id: picking.id, portions: Math.min(20, n) }
        : { key: crypto.randomUUID(), food_id: picking.id, grams: Math.min(5000, round1(n)) }
    setBasket((b) => [...b, ref])
    setPicking(null)
    setQuery('')
    confirmBuzz()
    searchRef.current?.focus()
  }

  const addCustom = () => {
    const name = String(custom?.name || '').trim()
    const kcal = toNumber(custom?.kcal)
    if (!name || kcal == null) {
      toast.error('A custom item needs a name and its kcal')
      return
    }
    setBasket((b) => [
      ...b,
      {
        key: crypto.randomUUID(),
        name,
        grams: toNumber(custom.grams) ?? 0,
        kcal,
        protein_g: toNumber(custom.protein_g) ?? 0,
        carbs_g: toNumber(custom.carbs_g) ?? 0,
        fat_g: toNumber(custom.fat_g) ?? 0,
      },
    ])
    setCustom(null)
  }

  const refsForSaving = () =>
    basket
      .filter((r) => r.food_id || r.recipe_id)
      .map((r) => (r.recipe_id ? { recipe_id: r.recipe_id, portions: r.portions } : { food_id: r.food_id, grams: r.grams }))

  const submit = async () => {
    if (basket.length === 0) return
    setBusy(true)
    try {
      if (saveAs) {
        const name = saveName.trim()
        if (!name) throw new Error('Give the saved meal a name')
        const refs = refsForSaving()
        if (refs.length === 0) throw new Error('A saved meal is made of foods or recipes from the list')
        const { error } = await supabase.from('saved_meals').insert({ name, items: refs, meal_slot: slot, sort_order: lib.saved.length })
        if (error) throw error.code === '23505' ? new Error(`There is already a saved meal called "${name}"`) : error
        if (mode === 'save') {
          toast.success(`Saved "${name}" ✓`)
          onLogged?.()
          onClose()
          return
        }
      }
      const day = localDay(new Date())
      const at = /^\d{2}:\d{2}$/.test(time) ? new Date(`${day}T${time}:00+01:00`) : new Date()
      const res = await logMeal({ items: priced, slot, source: 'manual', at, settings: lib.settings, todayLogs })
      confirmBuzz()
      toast.success(`${Number(res.kcal ?? totals.kcal).toLocaleString()} kcal logged ✓`)
      onLogged?.(res)
      onClose()
    } catch (err) {
      toast.error(err.message || 'Not logged: check connection')
    } finally {
      setBusy(false)
    }
  }

  const input =
    'w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]'

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={mode === 'save' ? 'New saved meal' : 'Add food'} desktopCenter>
      <div className="px-5 pb-5 pt-1 overflow-y-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">{mode === 'save' ? 'New saved meal' : 'Add food'}</h2>
          <button type="button" onClick={onClose} className="w-12 h-12 -mr-2 rounded-full text-muted hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>

        {/* Phase 3: a photo being read, or an 'auto' photo meal to check.
            Like a parsed note, it takes over the sheet until it is done. */}
        {photo && (
          <PhotoFlow
            file={photo.file ?? null}
            meal={photo.meal ?? null}
            lib={lib}
            todayLogs={todayLogs}
            onCancel={() => {
              setPhoto(null)
              onLogged?.()
              if (initialFile || checkMeal) onClose()
            }}
            onDone={(res) => {
              onLogged?.(res)
              onClose()
            }}
          />
        )}

        {/* Phase 3: the camera, one tap. capture=environment opens the back
            camera on a phone; on a desktop it is a file picker. */}
        {!photo && !parsed && mode === 'log' && basket.length === 0 && !picking && !custom && (
          photosReady ? (
            <label className="flex items-center justify-center gap-2 bg-accent text-black font-extrabold text-sm rounded-xl min-h-[52px] cursor-pointer hover:bg-accent/90">
              <span aria-hidden="true">📷</span> Snap the plate
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) setPhoto({ file: f })
                }}
              />
            </label>
          ) : (
            <p className="text-[11px] text-orange-300">Run supabase/migrations/052_diet_photos.sql to log meals from a photo.</p>
          )
        )}

        {/* Phase 2: a note the parser has read, waiting for "Looks right".
            It replaces the rest of the sheet until it is logged or dropped. */}
        {parsed && (
          <ParsedReview
            entry={parsed.entry}
            text={parsed.text}
            source={parsed.source}
            lib={lib}
            todayLogs={todayLogs}
            onBack={() => setParsed(null)}
            onDone={(res) => {
              onLogged?.(res)
              onClose()
            }}
          />
        )}

        {/* Phase 2: type or say it. Only for logging, and only before a
            meal has been started by hand, so the two ways do not mix. */}
        {!photo && !parsed && mode === 'log' && basket.length === 0 && !picking && !custom && <DescribeFood onParsed={setParsed} />}

        {/* What is in the meal so far */}
        {!photo && !parsed && priced.length > 0 && (
          <section aria-label="This meal" className="rounded-2xl bg-background/60 border border-white/10 p-3 space-y-2">
            <ul className="space-y-1">
              {priced.map((item, i) => (
                <li key={basket[i]?.key ?? i} className="flex items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0 truncate text-white">
                    {item.name}
                    <span className="text-muted"> · {item.recipe_id ? `${item.portions} portion${item.portions === 1 ? '' : 's'}` : `${round1(item.grams)} g`}</span>
                  </span>
                  <span className="tabular-nums text-white">{item.kcal}</span>
                  <span className="tabular-nums text-muted w-14 text-right">{round1(item.protein_g)} g P</span>
                  <button
                    type="button"
                    onClick={() => setBasket((b) => b.filter((_, j) => j !== i))}
                    className="w-10 h-10 rounded-full text-muted hover:text-red-300"
                    aria-label={`Remove ${item.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-white/5 pt-2">
              <span className="text-sm font-bold text-white tabular-nums">
                {totals.kcal.toLocaleString()} kcal · {totals.protein_g} g protein
              </span>
              {mode === 'log' && <VerdictBadge verdict={preview.verdict} />}
            </div>
            {mode === 'log' && preview.reason && <p className="text-[11px] text-muted leading-relaxed">{preview.reason}</p>}
          </section>
        )}

        {/* Find a food */}
        {!photo && !parsed && !picking && !custom && (
          <div className="space-y-2">
            <label htmlFor="diet-food-search" className="sr-only">
              Search foods and recipes
            </label>
            <input
              id="diet-food-search"
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search: beans, dodo, suya…"
              className={input}
              autoComplete="off"
            />
            <ul className="max-h-64 overflow-y-auto divide-y divide-white/5 rounded-2xl border border-white/5" aria-label="Foods and recipes">
              {results.map((r) => {
                const portion = r.kind === 'recipe' ? lib.portions.get(r.id) : null
                return (
                  <li key={`${r.kind}-${r.id}`}>
                    <button type="button" onClick={() => pick(r)} className="w-full flex items-center gap-3 px-3 py-2 min-h-[48px] text-left hover:bg-white/5">
                      <span aria-hidden="true">{r.kind === 'recipe' ? '🍲' : '🥘'}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-white truncate">{r.name}</span>
                        <span className="block text-[11px] text-muted">
                          {r.kind === 'recipe'
                            ? portion
                              ? `${portion.kcal} kcal · ${portion.protein_g} g protein a portion`
                              : 'No ingredients yet'
                            : `${Math.round(r.row.kcal_per_100g)} kcal / 100 g${r.row.portion_label ? ` · ${r.row.portion_label} ≈ ${Math.round(r.row.typical_portion_g)} g` : ''}`}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
              {results.length === 0 && <li className="px-3 py-3 text-sm text-muted">Nothing matches. Add it as a custom item below.</li>}
            </ul>
            {mode === 'log' && (
              <button type="button" onClick={() => setCustom({ name: query })} className="text-xs font-bold text-accent min-h-[48px]">
                + Custom item (not in the list)
              </button>
            )}
          </div>
        )}

        {/* How much */}
        {picking && (
          <section className="rounded-2xl border border-accent/30 bg-accent/5 p-4 space-y-3" aria-label={`How much ${picking.name}`}>
            <p className="text-sm font-bold text-white">{picking.name}</p>
            <div className="flex flex-wrap gap-2">
              {picking.kind === 'recipe'
                ? PORTION_STEPS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setAmount(String(p))}
                      className={`px-3 min-h-[44px] rounded-xl border text-xs font-bold ${toNumber(amount) === p ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 text-muted'}`}
                    >
                      {p} portion{p === 1 ? '' : 's'}
                    </button>
                  ))
                : portionOptions(picking.row).map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      onClick={() => setAmount(String(o.grams))}
                      className={`px-3 min-h-[44px] rounded-xl border text-xs font-bold ${toNumber(amount) === o.grams ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 text-muted'}`}
                    >
                      {o.label}
                    </button>
                  ))}
            </div>
            <div className="flex gap-2 items-center">
              <label htmlFor="diet-amount" className="text-xs text-muted shrink-0">
                {picking.kind === 'recipe' ? 'Portions' : 'Grams'}
              </label>
              <input
                id="diet-amount"
                type="number"
                inputMode="decimal"
                min="0"
                step={picking.kind === 'recipe' ? '0.25' : '5'}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={input}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setPicking(null)} className="min-h-[48px] rounded-xl bg-white/5 text-white text-sm font-bold">
                Back
              </button>
              <button type="button" onClick={addPicked} className="min-h-[48px] rounded-xl bg-accent text-black text-sm font-extrabold">
                Add
              </button>
            </div>
          </section>
        )}

        {/* Not in the list */}
        {custom && (
          <section className="rounded-2xl border border-white/10 p-4 space-y-2" aria-label="Custom item">
            <p className="text-sm font-bold text-white">Custom item</p>
            <input aria-label="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Name, e.g. mama put stew" className={input} />
            <div className="grid grid-cols-2 gap-2">
              <input aria-label="Grams" type="number" inputMode="decimal" value={custom.grams ?? ''} onChange={(e) => setCustom({ ...custom, grams: e.target.value })} placeholder="Grams" className={input} />
              <input aria-label="kcal" type="number" inputMode="decimal" value={custom.kcal ?? ''} onChange={(e) => setCustom({ ...custom, kcal: e.target.value })} placeholder="kcal" className={input} />
              <input aria-label="Protein (g)" type="number" inputMode="decimal" value={custom.protein_g ?? ''} onChange={(e) => setCustom({ ...custom, protein_g: e.target.value })} placeholder="Protein g" className={input} />
              <input aria-label="Fat (g)" type="number" inputMode="decimal" value={custom.fat_g ?? ''} onChange={(e) => setCustom({ ...custom, fat_g: e.target.value })} placeholder="Fat g" className={input} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setCustom(null)} className="min-h-[48px] rounded-xl bg-white/5 text-white text-sm font-bold">
                Back
              </button>
              <button type="button" onClick={addCustom} className="min-h-[48px] rounded-xl bg-accent text-black text-sm font-extrabold">
                Add
              </button>
            </div>
          </section>
        )}

        {/* Which meal, when, and whether to keep it */}
        {!photo && !parsed && basket.length > 0 && !picking && !custom && (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Meal">
              {SLOTS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={slot === s}
                  onClick={() => setSlot(s)}
                  className={`min-h-[48px] rounded-xl border text-[11px] font-bold ${slot === s ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 text-muted'}`}
                >
                  <span aria-hidden="true">{SLOT_ICONS[s]}</span> {SLOT_LABELS[s]}
                </button>
              ))}
            </div>
            {mode === 'log' && (
              <div className="flex items-center gap-2">
                <label htmlFor="diet-time" className="text-xs text-muted shrink-0">
                  Time
                </label>
                <input id="diet-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={input} />
              </div>
            )}
            {mode === 'log' && (
              <label className="flex items-center gap-3 text-sm text-white min-h-[48px]">
                <input type="checkbox" checked={saveAs} onChange={(e) => setSaveAs(e.target.checked)} className="w-5 h-5 accent-[var(--color-accent)]" />
                Also save it for one-tap logging
              </label>
            )}
            {saveAs && (
              <input aria-label="Saved meal name" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder='Name, e.g. "Beans container"' className={input} />
            )}
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="w-full min-h-[52px] rounded-xl bg-accent text-black font-extrabold text-sm disabled:opacity-60"
            >
              {busy ? 'Saving…' : mode === 'save' ? 'Save meal' : `Log ${totals.kcal.toLocaleString()} kcal`}
            </button>
          </div>
        )}
      </div>
    </Sheet>
  )
}
