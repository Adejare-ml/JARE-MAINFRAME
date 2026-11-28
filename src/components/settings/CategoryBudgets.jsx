import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { hasColumn } from '../../lib/schema'
import { ALL_CATEGORIES } from '../../lib/constants'
import Sheet from '../ui/Sheet'
import CategoryPickerList from '../ui/CategoryPickerList'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Button from '../ui/Button'
import IconButton from '../ui/IconButton'
import Money from '../ui/Money'
import CategoryMark from '../ui/CategoryMark'
import { Field, Input, controlClasses } from '../ui/Field'
import { SheetHeader, Notice, Code } from './parts'

/**
 * Per-category monthly targets (migration 024), sitting alongside the one
 * overall monthly budget target already set elsewhere in this page.
 *
 * Self-contained, like CategoryRules right above it -- its own fetch, its
 * own writes. One target per category: saving a category that already has
 * one replaces it (upsert on `user_id,category`, matching the unique index
 * the migration's own verify block proves arbitrates), so there is no
 * separate "edit" flow to build -- picking an existing category and saving
 * again is the edit.
 */

const EMPTY_FORM = { category: ALL_CATEGORIES[0], target_amount: '' }

export default function CategoryBudgets() {
  const [budgets, setBudgets] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)

  const available = hasColumn('category_budgets.category')

  const load = async () => {
    if (!available) {
      setLoading(false)
      return
    }
    const { data, error } = await supabase
      .from('category_budgets')
      .select('*')
      .order('category', { ascending: true })
    if (error) console.warn('Could not load category budgets:', error.message)
    setBudgets(error ? [] : data || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Closes the form Sheet and resets it back to its normal (not the
   *  category-picker) view, so reopening it later never starts mid-pick. */
  const closeForm = () => {
    setShowForm(false)
    setShowCategoryPicker(false)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    const target = Number(form.target_amount)
    if (!form.target_amount || isNaN(target) || target <= 0) {
      toast.error('Enter a monthly target above zero')
      return
    }

    setSaving(true)
    const { error } = await supabase
      .from('category_budgets')
      .upsert(
        { category: form.category, target_amount: target },
        { onConflict: 'user_id,category' },
      )
    setSaving(false)

    if (error) {
      toast.error('Failed to save: ' + error.message)
      return
    }
    toast.success('Budget saved')
    closeForm()
    setForm(EMPTY_FORM)
    load()
  }

  const handleDelete = async (id) => {
    setDeletingId(id)
    const { error } = await supabase.from('category_budgets').delete().eq('id', id)
    setDeletingId(null)
    if (error) {
      toast.error('Could not delete: ' + error.message)
      return
    }
    setBudgets((prev) => prev.filter((b) => b.id !== id))
  }

  if (loading) return null

  return (
    <Panel
      label="Category budgets"
      flush
      action={
        available && (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => {
              setForm(EMPTY_FORM)
              setShowForm(true)
            }}
          >
            New
          </Button>
        )
      }
    >
      {!available ? (
        <div className="p-3 lg:p-4">
          <Notice>
            Category budgets need <Code>supabase/migrations/024_category_budgets.sql</Code>. Run it in the Supabase SQL
            editor and this section starts working.
          </Notice>
        </div>
      ) : budgets.length === 0 ? (
        <p className="p-3 lg:p-4 text-body-sm text-muted">
          Nothing yet. Set one for a category worth watching. Budget shows how much of it is left, and flags the month
          you go over.
        </p>
      ) : (
        <ListRows as="ul" label="Category budgets">
          {budgets.map((budget) => (
            <ListRow
              key={budget.id}
              as="li"
              leading={<CategoryMark category={budget.category} />}
              title={budget.category}
              subtitle="Monthly target"
              trailing={
                <>
                  <Money amount={budget.target_amount} />
                  <IconButton
                    name="trash"
                    label={`Delete budget for ${budget.category}`}
                    onClick={() => handleDelete(budget.id)}
                    disabled={deletingId === budget.id}
                    className="-mr-2"
                  />
                </>
              }
            />
          ))}
        </ListRows>
      )}

      <Sheet
        isOpen={showForm}
        onClose={closeForm}
        title={showCategoryPicker ? 'Which category' : 'New category budget'}
        desktopCenter
      >
        {/* Swapped in as a view within this same Sheet, rather than a second
            nested one -- see CategoryPickerList's own comment for why. */}
        {showCategoryPicker ? (
          <>
            <SheetHeader title="Which category" onBack={() => setShowCategoryPicker(false)} />
            <div className="p-4 overflow-y-auto">
              <CategoryPickerList
                value={form.category}
                onSelect={(category) => {
                  setForm((f) => ({ ...f, category }))
                  setShowCategoryPicker(false)
                }}
              />
            </div>
          </>
        ) : (
          <>
            <SheetHeader title="New category budget" onClose={closeForm} />
            <form onSubmit={handleSave} className="p-4 space-y-4 overflow-y-auto">
              <Field label="Category">
                {({ id }) => (
                  <button
                    id={id}
                    type="button"
                    onClick={() => setShowCategoryPicker(true)}
                    className={`${controlClasses()} flex items-center gap-2 text-left`}
                  >
                    <CategoryMark category={form.category} size="sm" />
                    <span className="truncate">{form.category}</span>
                  </button>
                )}
              </Field>

              <Input
                id="budget-target"
                label="Monthly target"
                hint="In naira. Already have one for this category? Saving replaces it."
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.target_amount}
                onChange={(e) => setForm((f) => ({ ...f, target_amount: e.target.value }))}
                placeholder="15000"
              />

              <Button type="submit" full loading={saving}>
                {saving ? 'Saving…' : 'Save budget'}
              </Button>
            </form>
          </>
        )}
      </Sheet>
    </Panel>
  )
}
