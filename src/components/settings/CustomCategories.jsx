import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { hasColumn } from '../../lib/schema'
import { getCategoryIcon } from '../../lib/constants'
import {
  setCustomCategories,
  customCategories,
  validateCategoryName,
  CUSTOM_CATEGORY_ICONS,
  NAME_MAX,
} from '../../lib/categories'
import Sheet from '../ui/Sheet'

/**
 * The user's own category names (migration 030), in the same self-contained
 * shape as CategoryRules and CategoryBudgets above it.
 *
 * A save writes the row, then reloads the list into lib/categories so every
 * picker on the next render offers it. A delete removes the row and nothing
 * else: transactions filed under the name keep it, because the ledger is a
 * record of what happened, not a view of this table.
 */

const EMPTY_FORM = { name: '', icon: CUSTOM_CATEGORY_ICONS[0] }

export default function CustomCategories() {
  const [rows, setRows] = useState(() => customCategories())
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)

  const available = hasColumn('categories.name')

  const load = async () => {
    if (!available) {
      setLoading(false)
      return
    }
    const { data, error } = await supabase
      .from('categories')
      .select('id, name, section, icon')
      .order('created_at', { ascending: true })
    if (error) console.warn('Could not load custom categories:', error.message)
    else {
      // The store is what the pickers read; this component's own copy is
      // what it lists. Kept in step here rather than read back, so a row
      // the store dropped (a blank, a duplicate) is visible for deletion.
      setCustomCategories(data || [])
      setRows(data || [])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const closeForm = () => {
    setShowForm(false)
    setFormError(null)
  }

  const handleSave = async (e) => {
    e.preventDefault()
    const checked = validateCategoryName(form.name, rows)
    if (!checked.ok) {
      setFormError(checked.error)
      return
    }

    setSaving(true)
    const { error } = await supabase
      .from('categories')
      .insert({ name: checked.name, icon: form.icon || null })
    setSaving(false)

    if (error) {
      // 23505 is the unique index in 030 -- the same name by another case,
      // saved from another device since this list loaded.
      setFormError(error.code === '23505' ? `You already have ${checked.name}` : 'Failed to save: ' + error.message)
      return
    }
    toast.success(`${form.icon || ''} ${checked.name} added ✓`.trim())
    closeForm()
    setForm(EMPTY_FORM)
    load()
  }

  const handleDelete = async (row) => {
    setDeletingId(row.id)
    const { error } = await supabase.from('categories').delete().eq('id', row.id)
    setDeletingId(null)
    if (error) {
      toast.error('Could not delete: ' + error.message)
      return
    }
    toast.success(`${row.name} removed -- transactions filed under it keep the name`)
    load()
  }

  if (loading) return null

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
      <div className="flex items-center justify-between border-b border-white/5 pb-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
          Custom Categories
        </h2>
        {available && (
          <button
            onClick={() => {
              setForm(EMPTY_FORM)
              setFormError(null)
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
          Custom categories need{' '}
          <code className="font-mono text-yellow-200">
            supabase/migrations/030_categories.sql
          </code>
          . Run it in the Supabase SQL editor and this section starts working.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing yet. Add a name the built-in list is missing -- it shows up in
          every category picker and on the Budget breakdown.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-background/40 border border-white/5"
            >
              <p className="text-xs text-white/90 min-w-0 truncate flex items-center gap-1.5">
                <span aria-hidden="true">{row.icon || getCategoryIcon(row.name)}</span>
                <span className="truncate">{row.name}</span>
              </p>
              <button
                type="button"
                onClick={() => handleDelete(row)}
                disabled={deletingId === row.id}
                aria-label={`Delete category ${row.name}`}
                className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full hover:bg-red-500/10 text-muted hover:text-red-400 disabled:opacity-50"
              >
                🗑️
              </button>
            </li>
          ))}
        </ul>
      )}

      {available && (
        <p className="text-[11px] text-muted-dim leading-relaxed">
          The email sync files into built-in categories only, so it never invents
          a name. To route synced transactions here, add a Category Rule above
          that points at it.
        </p>
      )}

      <Sheet isOpen={showForm} onClose={closeForm} title="New category" desktopCenter>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">New category</h2>
            <button
              type="button"
              onClick={closeForm}
              aria-label="Close"
              className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-muted hover:text-white"
            >
              ✕
            </button>
          </div>

          {formError && (
            <p role="alert" className="text-xs text-red-400 font-medium">
              {formError}
            </p>
          )}

          <div>
            <label htmlFor="category-name" className="block text-xs text-muted mb-1.5">
              Name
            </label>
            <input
              id="category-name"
              value={form.name}
              maxLength={NAME_MAX}
              autoFocus
              onChange={(e) => {
                setForm((f) => ({ ...f, name: e.target.value }))
                if (formError) setFormError(null)
              }}
              placeholder="Pets"
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
            />
          </div>

          <div>
            <p className="text-xs text-muted mb-1.5">Icon</p>
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
              {CUSTOM_CATEGORY_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, icon }))}
                  aria-pressed={form.icon === icon}
                  aria-label={`Icon ${icon}`}
                  className={`w-11 h-11 flex items-center justify-center rounded-xl border text-lg transition-colors ${
                    form.icon === icon
                      ? 'bg-accent/10 border-accent'
                      : 'bg-background border-white/10 hover:border-white/20'
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-3.5 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add category'}
          </button>
        </form>
      </Sheet>
    </section>
  )
}
