import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { searchFoods } from '../../lib/diet/foods'
import { sumNutrition, toNumber, round1 } from '../../lib/diet/nutrition'
import { SLOT_LABELS } from '../../lib/diet/totals'
import { priceItems } from './api'
import AddFoodSheet from './AddFoodSheet'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Button from '../ui/Button'
import IconButton from '../ui/IconButton'
import Icon from '../ui/Icon'
import Badge from '../ui/Badge'
import Label from '../ui/Label'
import Money from '../ui/Money'
import Segmented from '../ui/Segmented'
import { Input, controlClasses } from '../ui/Field'

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
    ['saved', 'Saved'],
    ['recipes', 'Recipes'],
    ['foods', 'Foods'],
    ['pantry', 'Pantry'],
  ]
  return (
    <div className="space-y-3">
      <Segmented label="Library" full options={tabs.map(([value, label]) => ({ value, label }))} value={section} onChange={setSection} />
      {section === 'saved' && <SavedMeals lib={lib} onChanged={onChanged} />}
      {section === 'recipes' && <Recipes lib={lib} onChanged={onChanged} />}
      {section === 'foods' && <Foods lib={lib} onChanged={onChanged} />}
      {section === 'pantry' && <Pantry />}
    </div>
  )
}

const input = controlClasses()

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
    <Panel label="Saved meals" meta={`${lib.saved.length} saved`} flush>
      <p className="px-3 py-2 lg:px-4 text-body-sm text-muted">One tap on the Today screen logs any of these.</p>
      <div className={lib.saved.length ? 'border-t border-border' : ''}>
      <ListRows as="ul">
        {lib.saved.map((s) => {
          const items = priceItems(s.items, lib)
          const n = sumNutrition(items)
          return (
            <ListRow
              key={s.id}
              as="li"
              title={s.name}
              subtitle={`${items.map((i) => i.name).join(', ')} · ${s.meal_slot ? SLOT_LABELS[s.meal_slot] : 'any meal'}`}
              meta={`${n.kcal} kcal · ${n.protein_g} g protein`}
              trailing={
                confirm === s.id ? (
                  <Button size="sm" variant="danger" onClick={() => remove(s.id)}>
                    Delete?
                  </Button>
                ) : (
                  <IconButton name="close" label={`Delete ${s.name}`} onClick={() => setConfirm(s.id)} className="-mr-3" />
                )
              }
            />
          )
        })}
      </ListRows>
      </div>
      <div className="p-3 lg:p-4 border-t border-border">
        <Button variant="secondary" icon="plus" full onClick={() => setAdding(true)}>
          New saved meal
        </Button>
      </div>
      <AddFoodSheet isOpen={adding} onClose={() => setAdding(false)} lib={lib} mode="save" onLogged={onChanged} />
    </Panel>
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
    <Panel label="Recipes" meta={`${lib.recipes.length} recipe${lib.recipes.length === 1 ? '' : 's'}`} flush>
      <p className="px-3 py-2 lg:px-4 text-body-sm text-muted border-b border-border">Ingredients by raw weight. Nutrition per portion is worked out from them, so changing the pot changes every portion.</p>
      <ul className={`divide-y divide-border ${lib.recipes.length ? 'border-t border-border' : ''}`}>
        {lib.recipes.map((r) => {
          const p = lib.portions.get(r.id)
          const isOpen = open === r.id
          return (
            <li key={r.id} className={isOpen ? 'bg-surface-2' : ''}>
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : r.id)}
                className="w-full flex items-center gap-3 px-3 py-2 min-h-14 text-left transition-colors duration-150 hover:bg-surface-2"
                aria-expanded={isOpen}
              >
                <span className="flex-1 min-w-0">
                  <span className="block text-body text-foreground truncate">{r.name}</span>
                  <span className="block text-body-sm text-muted truncate">
                    {round1(r.portions)} portions · {p ? `${p.kcal} kcal, ${p.protein_g} g protein, ${p.grams} g each` : 'no ingredients yet'}
                  </span>
                </span>
                <Icon name={isOpen ? 'chevU' : 'chevD'} size={18} className="text-muted shrink-0" />
              </button>
              {isOpen && <RecipeEditor recipe={r} lib={lib} onChanged={onChanged} />}
            </li>
          )
        })}
      </ul>
      <form onSubmit={create} className="flex gap-2 p-3 lg:p-4 border-t border-border">
        <label htmlFor="new-recipe" className="sr-only">
          New recipe name
        </label>
        <input id="new-recipe" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New recipe, e.g. Egusi pot" className={input} />
        <Button type="submit">Add</Button>
      </form>
    </Panel>
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
    toast.success('Recipe saved')
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
      <ul className="divide-y divide-border border border-border rounded-panel bg-card">
        {ingredients.map((ing) => (
          <li key={ing.id} className="flex items-center gap-2 pl-3 min-h-12">
            <span className="flex-1 min-w-0 truncate text-body text-foreground">{lib.foodsById.get(ing.food_id)?.name ?? 'Missing food'}</span>
            <label className="sr-only" htmlFor={`ing-${ing.id}`}>
              Grams of {lib.foodsById.get(ing.food_id)?.name}
            </label>
            <input
              id={`ing-${ing.id}`}
              type="number"
              inputMode="decimal"
              defaultValue={ing.grams}
              onBlur={(e) => setIngredient(ing, e.target.value)}
              className={`${controlClasses()} !w-24 text-right`}
            />
            <span className="type-data text-muted">g</span>
            <IconButton name="close" label="Remove ingredient" onClick={() => removeIngredient(ing)} />
          </li>
        ))}
        {ingredients.length === 0 && <li className="px-3 py-3 text-body-sm text-muted">No ingredients yet.</li>}
      </ul>
      <form onSubmit={addIngredient} className="space-y-2">
        {pick ? (
          <p className="flex items-center gap-2 text-body text-foreground">
            <span className="min-w-0 truncate">
              Adding <b className="font-semibold">{pick.name}</b>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setPick(null)}>
              Change
            </Button>
          </p>
        ) : (
          <>
            <input aria-label="Find an ingredient" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add an ingredient…" className={input} />
            {matches.length > 0 && (
              <ul className="rounded-panel border border-border bg-card divide-y divide-border">
                {matches.map((m) => (
                  <li key={m.id}>
                    <ListRow onClick={() => setPick(m)} title={m.name} trailing={<Icon name="plus" size={18} className="text-muted" />} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {pick && (
          <div className="flex gap-2">
            <input aria-label="Grams" type="number" inputMode="decimal" value={grams} onChange={(e) => setGrams(e.target.value)} placeholder="Grams (raw)" className={input} />
            <Button type="submit">Add</Button>
          </div>
        )}
      </form>
      <div className="grid grid-cols-2 gap-2">
        <Input label="Portions" type="number" inputMode="decimal" value={portions} onChange={(e) => setPortions(e.target.value)} />
        <Input label="Cooked g, optional" type="number" inputMode="decimal" value={cooked} onChange={(e) => setCooked(e.target.value)} />
      </div>
      <Button variant="secondary" full onClick={saveRecipe}>
        Save portions
      </Button>
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
    toast.success('Food saved')
    setEditing(null)
    onChanged()
  }

  if (editing) {
    const set = (k) => (e) => setEditing((f) => ({ ...f, [k]: e.target.value }))
    return (
      <Panel label={editing.id ? 'Edit food' : 'New food'}>
      <form onSubmit={save} className="space-y-3" aria-label={editing.id ? 'Edit food' : 'New food'}>
        <input aria-label="Name" value={editing.name} onChange={set('name')} placeholder="Name" className={input} />
        <input aria-label="Other names" value={editing.aliases} onChange={set('aliases')} placeholder="Other names, comma-separated" className={input} />
        <Label as="p">Per 100 g as eaten</Label>
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="kcal per 100 g" type="number" inputMode="decimal" value={editing.kcal_per_100g} onChange={set('kcal_per_100g')} placeholder="kcal" className={input} />
          <input aria-label="Protein per 100 g" type="number" inputMode="decimal" value={editing.protein_g} onChange={set('protein_g')} placeholder="Protein g" className={input} />
          <input aria-label="Carbs per 100 g" type="number" inputMode="decimal" value={editing.carbs_g} onChange={set('carbs_g')} placeholder="Carbs g" className={input} />
          <input aria-label="Fat per 100 g" type="number" inputMode="decimal" value={editing.fat_g} onChange={set('fat_g')} placeholder="Fat g" className={input} />
          <input aria-label="Typical portion in grams" type="number" inputMode="decimal" value={editing.typical_portion_g} onChange={set('typical_portion_g')} placeholder="Portion g" className={input} />
          <input aria-label="Portion label" value={editing.portion_label} onChange={set('portion_label')} placeholder="e.g. 1 wrap" className={input} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button type="submit">Save</Button>
        </div>
      </form>
      </Panel>
    )
  }

  return (
    <Panel label="Foods" meta={`${lib.foods.length} foods`} flush>
      <div className="flex gap-2 p-3 lg:p-4 border-b border-border">
        <input aria-label="Search foods" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${lib.foods.length} foods`} className={input} />
        <Button icon="plus" onClick={() => setEditing({ ...EMPTY_FOOD, name: query })}>
          New
        </Button>
      </div>
      <ListRows as="ul">
        {list.map(({ row: f }) => (
          <li key={f.id}>
            <ListRow
              onClick={() => setEditing({ ...EMPTY_FOOD, ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v == null ? '' : v])), aliases: (f.aliases || []).join(', ') })}
              title={
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{f.name}</span>
                  {f.estimated && <Badge label="estimated" tone="warn" />}
                </span>
              }
              subtitle={(f.aliases || []).join(', ') || undefined}
              trailing={
                <span className="type-data text-muted text-right whitespace-nowrap">
                  {round1(f.kcal_per_100g)} kcal
                  <br />
                  {round1(f.protein_g)} g P / 100 g
                </span>
              }
            />
          </li>
        ))}
      </ListRows>
    </Panel>
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
    <Panel label="Pantry" meta={`${items.filter((i) => !i.finished).length} at home`} flush>
      <div className="p-3 lg:p-4 space-y-3 border-b border-border">
        <p className="text-body-sm text-muted">What is at home. The coach (Phase 4) suggests meals from it; from Phase 2 you can also say "bought 2 kg beans for 3,000".</p>
        <form onSubmit={add} className="grid grid-cols-2 gap-2">
          <input aria-label="Item" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Item, e.g. brown beans" className={`${input} col-span-2`} />
          <input aria-label="Quantity" type="number" inputMode="decimal" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} placeholder="Qty" className={input} />
          <input aria-label="Unit" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="kg, crates…" className={input} />
          <input aria-label="Cost in naira" type="number" inputMode="numeric" value={form.cost_naira} onChange={(e) => setForm({ ...form, cost_naira: e.target.value })} placeholder="Cost in naira" className={input} />
          <Button type="submit">Add</Button>
        </form>
      </div>
      <ListRows as="ul">
        {shown.map((i) => (
          <ListRow
            key={i.id}
            as="li"
            title={
              <span className={i.finished ? 'text-muted line-through' : ''}>
                {i.name}
                {i.quantity != null && (
                  <span className="text-muted">
                    {' '}
                    · {round1(i.quantity)} {i.unit || ''}
                  </span>
                )}
              </span>
            }
            trailing={
              <>
                {i.cost_naira != null && <Money amount={i.cost_naira} tone="muted" className="text-body-sm" />}
                <Button size="sm" variant="secondary" onClick={() => toggle(i)}>
                  {i.finished ? 'Restock' : 'Finished'}
                </Button>
              </>
            }
          />
        ))}
        {shown.length === 0 && <li className="px-3 py-3 text-body-sm text-muted">Nothing in the pantry list.</li>}
      </ListRows>
      {items.some((i) => i.finished) && (
        <div className="px-3 py-1 border-t border-border">
          <Button size="sm" variant="ghost" onClick={() => setShowFinished((s) => !s)}>
            {showFinished ? 'Hide finished' : 'Show finished'}
          </Button>
        </div>
      )}
    </Panel>
  )
}
