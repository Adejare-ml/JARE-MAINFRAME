import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { hasColumn } from '../../lib/schema'
import { formatNaira } from '../../lib/formatters'
import { ALL_CATEGORIES, getCategoryIcon } from '../../lib/constants'
import Sheet from '../ui/Sheet'
import CategoryPickerList from '../ui/CategoryPickerList'

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
    toast.success('Budget saved ✓')
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
    <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
      <div className="flex items-center justify-between border-b border-white/5 pb-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
          Category Budgets
        </h2>
        {available && (
          <button
            onClick={() => {
              setForm(EMPTY_FORM)
              setShowForm(true)
            }}
            className="px-3 py-1.5 bg-white/10 hover:bg-accent text-white hover:text-black rounded-lg text-xs font-bold transition-all min-h-[44px]"
          >
            + New
          </button>
        )}
      </div>

      {!available ? (
        <p className="text-xs text-yellow-400 leading-relaxed">
          Category budgets need{' '}
          <code className="font-mono text-yellow-200">
            supabase/migrations/024_category_budgets.sql
          </code>
          . Run it in the Supabase SQL editor and this section starts working.
        </p>
      ) : budgets.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing yet. Set one for a category worth watching -- Budget shows
          how much of it is left, and flags the month you go over.
        </p>
      ) : (
        <ul className="space-y-2">
          {budgets.map((budget) => (
            <li
              key={budget.id}
              className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-background/40 border border-white/5"
            >
              <p className="text-xs text-white/90 min-w-0 truncate flex items-center gap-1.5">
                <span aria-hidden="true">{getCategoryIcon(budget.category)}</span>
                <span className="truncate">{budget.category}</span>
                <span className="text-muted">·</span>
                <span className="font-semibold text-accent money">{formatNaira(budget.target_amount)}</span>
                <span className="text-muted">/mo</span>
              </p>
              <button
                type="button"
                onClick={() => handleDelete(budget.id)}
                disabled={deletingId === budget.id}
                aria-label={`Delete budget for ${budget.category}`}
                className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full hover:bg-red-500/10 text-muted hover:text-red-400 disabled:opacity-50"
              >
                🗑️
              </button>
            </li>
          ))}
        </ul>
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
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Which category</h2>
              <button
                type="button"
                onClick={() => setShowCategoryPicker(false)}
                className="text-sm font-semibold text-muted hover:text-white min-h-[44px] px-2 flex items-center gap-1"
              >
                ← Back
              </button>
            </div>
            <CategoryPickerList
              value={form.category}
              onSelect={(category) => {
                setForm((f) => ({ ...f, category }))
                setShowCategoryPicker(false)
              }}
            />
          </div>
        ) : (
        <form onSubmit={handleSave} className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">New category budget</h2>
            <button
              type="button"
              onClick={closeForm}
              aria-label="Close"
              className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-muted hover:text-white"
            >
              ✕
            </button>
          </div>

          <div>
            <label className="block text-xs text-muted mb-1.5">Category</label>
            <button
              type="button"
              onClick={() => setShowCategoryPicker(true)}
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px] flex items-center gap-2"
            >
              <span className="text-lg" aria-hidden="true">{getCategoryIcon(form.category)}</span>
              <span className="truncate">{form.category}</span>
            </button>
          </div>

          <div>
            <label htmlFor="budget-target" className="block text-xs text-muted mb-1.5">
              Monthly target (₦)
            </label>
            <input
              id="budget-target"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={form.target_amount}
              onChange={(e) => setForm((f) => ({ ...f, target_amount: e.target.value }))}
              placeholder="15000"
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
            />
            <p className="text-[11px] text-muted-dim mt-1.5">
              Already have one for this category? Saving replaces it.
            </p>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-3.5 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save budget'}
          </button>
        </form>
        )}
      </Sheet>
    </section>
  )
}
