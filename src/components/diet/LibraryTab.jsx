import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { searchFoods } from '../../lib/diet/foods'
import { sumNutrition, toNumber, round1 } from '../../lib/diet/nutrition'
import { SLOT_LABELS } from '../../lib/diet/totals'
import { formatNaira } from '../../lib/formatters'
import { priceItems } from './api'
import AddFoodSheet from './AddFoodSheet'

/**
 * Library: the saved meals, recipes, foods and pantry that logging draws on.
 *
 * Kept to plain lists and small forms. Foods carry an "estimated" mark from
 * the 049 seed (see that file for why every seeded row is marked); editing
 * a food's figures clears the mark, on the reading that a figure the owner
 * typed in is one he checked. Correcting a food changes future logs only:
 * meal_items keep the figures they were logged with.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
export default function LibraryTab({ lib, onChanged }) {
  const [section, setSection] = useState('saved')
  const tabs = [
    ['saved', 'Saved meals'],
    ['recipes', 'Recipes'],
    ['foods', 'Foods'],
    ['pantry', 'Pantry'],
  ]
  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto scrollbar-none" role="tablist" aria-label="Library">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={section === key}
            onClick={() => setSection(key)}
            className={`shrink-0 px-4 min-h-[44px] rounded-full text-xs font-bold border ${section === key ? 'border-accent bg-accent/10 text-accent' : 'border-white/10 text-muted'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {section === 'saved' && <SavedMeals lib={lib} onChanged={onChanged} />}
      {section === 'recipes' && <Recipes lib={lib} onChanged={onChanged} />}
      {section === 'foods' && <Foods lib={lib} onChanged={onChanged} />}
      {section === 'pantry' && <Pantry />}
    </div>
  )
}

const card = 'bg-card rounded-3xl p-5 border border-white/5'
const input = 'w-full px-3 py-2.5 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[44px]'

function SavedMeals({ lib, onChanged }) {
  const [adding, setAdding] = useState(false)
  const [confirm, setConfirm] = useState(null)

  const remove = async (id) => {
    const { error } = await supabase.from('saved_meals').delete().eq('id', id)
    if (error) toast.error('Could not delete: ' + error.message)
    setConfirm(null)
    onChanged()
  }

  return (
    <section className={`${card} space-y-3`} aria-label="Saved meals">
      <p className="text-[11px] text-muted">One tap on the Today screen logs any of these.</p>
      <ul className="divide-y divide-white/5">
        {lib.saved.map((s) => {
          const items = priceItems(s.items, lib)
          const n = sumNutrition(items)
          return (
            <li key={s.id} className="py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-white truncate">{s.name}</p>
                <p className="text-[11px] text-muted truncate">
                  {items.map((i) => i.name).join(', ')} · {s.meal_slot ? SLOT_LABELS[s.meal_slot] : 'any meal'}
                </p>
              </div>
              <span className="text-sm text-white tabular-nums shrink-0">
                {n.kcal} kcal · {n.protein_g} g
              </span>
              {confirm === s.id ? (
                <button type="button" onClick={() => remove(s.id)} className="px-3 min-h-[44px] rounded-xl bg-red-500/20 text-red-300 text-xs font-bold">
                  Delete?
                </button>
              ) : (
                <button type="button" onClick={() => setConfirm(s.id)} className="min-w-[44px] min-h-[44px] rounded-full text-muted hover:text-red-300" aria-label={`Delete ${s.name}`}>
                  ✕
                </button>
              )}
            </li>
          )
        })}
      </ul>
      <button type="button" onClick={() => setAdding(true)} className="w-full min-h-[48px] rounded-xl bg-white/5 border border-white/10 text-white text-sm font-bold">
        ＋ New saved meal
      </button>
      <AddFoodSheet isOpen={adding} onClose={() => setAdding(false)} lib={lib} mode="save" onLogged={onChanged} />
    </section>
  )
}

function Recipes({ lib, onChanged }) {
  const [open, setOpen] = useState(null)
  const [newName, setNewName] = useState('')

  const create = async (e) => {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    const { data, error } = await supabase.from('recipes').insert({ name, portions: 1 }).select('id').single()
    if (error) {
      toast.error(error.code === '23505' ? `There is already a recipe called "${name}"` : error.message)
      return
    }
    setNewName('')
    setOpen(data.id)
    onChanged()
  }

  return (
    <section className={`${card} space-y-3`} aria-label="Recipes">
      <p className="text-[11px] text-muted">Ingredients by raw weight. Nutrition per portion is worked out from them, so changing the pot changes every portion.</p>
      <ul className="space-y-2">
        {lib.recipes.map((r) => {
          const p = lib.portions.get(r.id)
          return (
            <li key={r.id} className="rounded-2xl border border-white/5 bg-background/40">
              <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} className="w-full flex items-center gap-3 p-3 min-h-[52px] text-left" aria-expanded={open === r.id}>
                <span aria-hidden="true">🍲</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-bold text-white truncate">{r.name}</span>
                  <span className="block text-[11px] text-muted">
                    {round1(r.portions)} portions · {p ? `${p.kcal} kcal, ${p.protein_g} g protein, ${p.grams} g each` : 'no ingredients yet'}
                  </span>
                </span>
                <span className="text-muted" aria-hidden="true">
                  {open === r.id ? '▴' : '▾'}
                </span>
              </button>
              {open === r.id && <RecipeEditor recipe={r} lib={lib} onChanged={onChanged} />}
            </li>
          )
        })}
      </ul>
      <form onSubmit={create} className="flex gap-2">
        <label htmlFor="new-recipe" className="sr-only">
          New recipe name
        </label>
        <input id="new-recipe" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New recipe, e.g. Egusi pot" className={input} />
        <button type="submit" className="px-4 rounded-xl bg-accent text-black text-sm font-bold min-h-[44px]">
          Add
        </button>
      </form>
    </section>
  )
}

function RecipeEditor({ recipe, lib, onChanged }) {
  const [portions, setPortions] = useState(String(recipe.portions))
  const [cooked, setCooked] = useState(recipe.cooked_weight_g == null ? '' : String(recipe.cooked_weight_g))
  const [query, setQuery] = useState('')
  const [grams, setGrams] = useState('')
  const [pick, setPick] = useState(null)
  const ingredients = lib.ingredientsByRecipe.get(recipe.id) || []
  const matches = useMemo(() => (query ? searchFoods(query, lib.foods, [], 6) : []), [query, lib.foods])

  const saveRecipe = async () => {
    const p = toNumber(portions)
    const c = cooked.trim() === '' ? null : toNumber(cooked)
    if (!p || p <= 0 || p > 100) return toast.error('Portions between 1 and 100')
    const { error } = await supabase.from('recipes').update({ portions: p, cooked_weight_g: c }).eq('id', recipe.id)
    if (error) return toast.error(error.message)
    toast.success('Recipe saved ✓')
    onChanged()
  }

  const setIngredient = async (ing, value) => {
    const g = toNumber(value)
    if (g == null || g <= 0 || g === toNumber(ing.grams)) return
    const { error } = await supabase.from('recipe_ingredients').update({ grams: g }).eq('id', ing.id)
    if (error) toast.error(error.message)
    onChanged()
  }

  const removeIngredient = async (ing) => {
    const { error } = await supabase.from('recipe_ingredients').delete().eq('id', ing.id)
    if (error) toast.error(error.message)
    onChanged()
  }

  const addIngredient = async (e) => {
    e.preventDefault()
    const g = toNumber(grams)
    if (!pick || !g || g <= 0) return toast.error('Pick a food and its grams')
    const { error } = await supabase.from('recipe_ingredients').insert({ recipe_id: recipe.id, food_id: pick.id, grams: g, position: ingredients.length })
    if (error) return toast.error(error.message)
    setPick(null)
    setQuery('')
    setGrams('')
    onChanged()
  }

  return (
    <div className="px-3 pb-3 space-y-3">
      <ul className="space-y-1">
        {ingredients.map((ing) => (
          <li key={ing.id} className="flex items-center gap-2 text-sm">
            <span className="flex-1 min-w-0 truncate text-white">{lib.foodsById.get(ing.food_id)?.name ?? 'Missing food'}</span>
            <label className="sr-only" htmlFor={`ing-${ing.id}`}>
              Grams of {lib.foodsById.get(ing.food_id)?.name}
            </label>
            <input
              id={`ing-${ing.id}`}
              type="number"
              inputMode="decimal"
              defaultValue={ing.grams}
              onBlur={(e) => setIngredient(ing, e.target.value)}
              className="w-24 px-2 py-2 bg-background border border-white/10 rounded-lg text-right text-white min-h-[40px]"
            />
            <span className="text-xs text-muted">g</span>
            <button type="button" onClick={() => removeIngredient(ing)} className="min-w-[40px] min-h-[40px] rounded-full text-muted hover:text-red-300" aria-label="Remove ingredient">
              ✕
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={addIngredient} className="space-y-2">
        {pick ? (
          <p className="text-xs text-white">
            Adding <b>{pick.name}</b>{' '}
            <button type="button" onClick={() => setPick(null)} className="text-accent">
              change
            </button>
          </p>
        ) : (
          <>
            <input aria-label="Find an ingredient" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add an ingredient…" className={input} />
            {matches.length > 0 && (
              <ul className="rounded-xl border border-white/5 divide-y divide-white/5">
                {matches.map((m) => (
                  <li key={m.id}>
                    <button type="button" onClick={() => setPick(m)} className="w-full text-left px-3 py-2 text-sm text-white min-h-[44px] hover:bg-white/5">
                      {m.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {pick && (
          <div className="flex gap-2">
            <input aria-label="Grams" type="number" inputMode="decimal" value={grams} onChange={(e) => setGrams(e.target.value)} placeholder="Grams (raw)" className={input} />
            <button type="submit" className="px-4 rounded-xl bg-accent text-black text-sm font-bold min-h-[44px]">
              Add
            </button>
          </div>
        )}
      </form>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-muted space-y-1">
          <span className="block">Portions</span>
          <input type="number" inputMode="decimal" value={portions} onChange={(e) => setPortions(e.target.value)} className={input} />
        </label>
        <label className="text-[11px] text-muted space-y-1">
          <span className="block">Cooked weight (g), optional</span>
          <input type="number" inputMode="decimal" value={cooked} onChange={(e) => setCooked(e.target.value)} className={input} />
        </label>
      </div>
      <button type="button" onClick={saveRecipe} className="w-full min-h-[44px] rounded-xl bg-white/5 border border-white/10 text-white text-sm font-bold">
        Save portions
      </button>
    </div>
  )
}

const EMPTY_FOOD = { name: '', aliases: '', kcal_per_100g: '', protein_g: '', carbs_g: '', fat_g: '', typical_portion_g: '', portion_label: '' }

function Foods({ lib, onChanged }) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const list = useMemo(() => searchFoods(query, lib.foods, [], 200), [query, lib.foods])

  const save = async (e) => {
    e.preventDefault()
    const f = editing
    const row = {
      name: f.name.trim(),
      aliases: String(f.aliases || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      kcal_per_100g: toNumber(f.kcal_per_100g),
      protein_g: toNumber(f.protein_g) ?? 0,
      carbs_g: toNumber(f.carbs_g) ?? 0,
      fat_g: toNumber(f.fat_g) ?? 0,
      typical_portion_g: toNumber(f.typical_portion_g),
      portion_label: f.portion_label?.trim() || null,
    }
    if (!row.name || row.kcal_per_100g == null) return toast.error('A food needs a name and kcal per 100 g')
    const res = f.id
      ? await supabase.from('foods').update({ ...row, estimated: false, source: 'Entered by hand' }).eq('id', f.id)
      : await supabase.from('foods').insert({ ...row, estimated: false, source: 'Entered by hand' })
    if (res.error) return toast.error(res.error.code === '23505' ? `There is already a food called "${row.name}"` : res.error.message)
    toast.success('Food saved ✓')
    setEditing(null)
    onChanged()
  }

  if (editing) {
    const set = (k) => (e) => setEditing((f) => ({ ...f, [k]: e.target.value }))
    return (
      <form onSubmit={save} className={`${card} space-y-3`} aria-label={editing.id ? 'Edit food' : 'New food'}>
        <p className="text-sm font-bold text-white">{editing.id ? 'Edit food' : 'New food'}</p>
        <input aria-label="Name" value={editing.name} onChange={set('name')} placeholder="Name" className={input} />
        <input aria-label="Other names" value={editing.aliases} onChange={set('aliases')} placeholder="Other names, comma-separated" className={input} />
        <p className="text-[11px] text-muted">Per 100 g as eaten</p>
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="kcal per 100 g" type="number" inputMode="decimal" value={editing.kcal_per_100g} onChange={set('kcal_per_100g')} placeholder="kcal" className={input} />
          <input aria-label="Protein per 100 g" type="number" inputMode="decimal" value={editing.protein_g} onChange={set('protein_g')} placeholder="Protein g" className={input} />
          <input aria-label="Carbs per 100 g" type="number" inputMode="decimal" value={editing.carbs_g} onChange={set('carbs_g')} placeholder="Carbs g" className={input} />
          <input aria-label="Fat per 100 g" type="number" inputMode="decimal" value={editing.fat_g} onChange={set('fat_g')} placeholder="Fat g" className={input} />
          <input aria-label="Typical portion in grams" type="number" inputMode="decimal" value={editing.typical_portion_g} onChange={set('typical_portion_g')} placeholder="Portion g" className={input} />
          <input aria-label="Portion label" value={editing.portion_label} onChange={set('portion_label')} placeholder="e.g. 1 wrap" className={input} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setEditing(null)} className="min-h-[48px] rounded-xl bg-white/5 text-white text-sm font-bold">
            Cancel
          </button>
          <button type="submit" className="min-h-[48px] rounded-xl bg-accent text-black text-sm font-extrabold">
            Save
          </button>
        </div>
      </form>
    )
  }

  return (
    <section className={`${card} space-y-3`} aria-label="Foods">
      <div className="flex gap-2">
        <input aria-label="Search foods" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${lib.foods.length} foods`} className={input} />
        <button type="button" onClick={() => setEditing({ ...EMPTY_FOOD, name: query })} className="px-4 rounded-xl bg-accent text-black text-sm font-bold min-h-[44px] shrink-0">
          ＋ New
        </button>
      </div>
      <ul className="divide-y divide-white/5">
        {list.map(({ row: f }) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => setEditing({ ...EMPTY_FOOD, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v == null ? '' : v])), aliases: (f.aliases || []).join(', ') })}
              className="w-full flex items-center gap-3 py-2 min-h-[48px] text-left"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-white truncate">
                  {f.name}
                  {f.estimated && <span className="ml-2 text-[10px] text-orange-300 font-bold uppercase">estimated</span>}
                </span>
                <span className="block text-[11px] text-muted truncate">{(f.aliases || []).join(', ')}</span>
              </span>
              <span className="text-[11px] text-muted tabular-nums text-right shrink-0">
                {round1(f.kcal_per_100g)} kcal
                <br />
                {round1(f.protein_g)} g P / 100 g
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Pantry() {
  const [items, setItems] = useState([])
  const [form, setForm] = useState({ name: '', quantity: '', unit: '', cost_naira: '' })
  const [showFinished, setShowFinished] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('pantry_items').select('*').order('finished').order('bought_at', { ascending: false }).limit(100)
    if (error) toast.error(error.message)
    else setItems(data || [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const add = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) return
    const { error } = await supabase.from('pantry_items').insert({
      name: form.name.trim(),
      quantity: toNumber(form.quantity),
      unit: form.unit.trim() || null,
      cost_naira: toNumber(form.cost_naira),
    })
    if (error) return toast.error(error.message)
    setForm({ name: '', quantity: '', unit: '', cost_naira: '' })
    load()
  }

  const toggle = async (item) => {
    const { error } = await supabase.from('pantry_items').update({ finished: !item.finished, updated_at: new Date().toISOString() }).eq('id', item.id)
    if (error) toast.error(error.message)
    load()
  }

  const shown = items.filter((i) => showFinished || !i.finished)

  return (
    <section className={`${card} space-y-3`} aria-label="Pantry">
      <p className="text-[11px] text-muted">What is at home. The coach (Phase 4) suggests meals from it; from Phase 2 you can also say "bought 2 kg beans for 3,000".</p>
      <form onSubmit={add} className="grid grid-cols-2 gap-2">
        <input aria-label="Item" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Item, e.g. brown beans" className={`${input} col-span-2`} />
        <input aria-label="Quantity" type="number" inputMode="decimal" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="Qty" className={input} />
        <input aria-label="Unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="kg, crates…" className={input} />
        <input aria-label="Cost in naira" type="number" inputMode="numeric" value={form.cost_naira} onChange={(e) => setForm({ ...form, cost_naira: e.target.value })} placeholder="₦ cost" className={input} />
        <button type="submit" className="rounded-xl bg-accent text-black text-sm font-bold min-h-[44px]">
          Add
        </button>
      </form>
      <ul className="divide-y divide-white/5">
        {shown.map((i) => (
          <li key={i.id} className="flex items-center gap-3 py-2">
            <span className={`flex-1 min-w-0 text-sm truncate ${i.finished ? 'text-muted line-through' : 'text-white'}`}>
              {i.name}
              {i.quantity != null && (
                <span className="text-muted">
                  {' '}
                  · {round1(i.quantity)} {i.unit || ''}
                </span>
              )}
            </span>
            {i.cost_naira != null && <span className="text-[11px] text-muted money">{formatNaira(i.cost_naira)}</span>}
            <button type="button" onClick={() => toggle(i)} className="px-3 min-h-[44px] rounded-xl bg-white/5 text-xs font-bold text-white">
              {i.finished ? 'Restock' : 'Finished'}
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="py-3 text-sm text-muted">Nothing in the pantry list.</li>}
      </ul>
      {items.some((i) => i.finished) && (
        <button type="button" onClick={() => setShowFinished((s) => !s)} className="text-xs text-accent font-bold min-h-[44px]">
          {showFinished ? 'Hide finished' : 'Show finished'}
        </button>
      )}
    </section>
  )
}
