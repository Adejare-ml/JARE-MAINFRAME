import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { hasColumn } from '../../lib/schema'
import { getCategoryIcon, resolveIcon } from '../../lib/constants'
import {
  setCustomCategories,
  customCategories,
  validateCategoryName,
  CUSTOM_CATEGORY_ICONS,
  NAME_MAX,
} from '../../lib/categories'
import Sheet from '../ui/Sheet'
import Icon from '../ui/Icon'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Button from '../ui/Button'
import IconButton from '../ui/IconButton'
import Label from '../ui/Label'
import { Input } from '../ui/Field'
import { SheetHeader, Notice, Code } from './parts'

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
    toast.success(`${checked.name} added`)
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
    toast.success(`${row.name} removed. Transactions filed under it keep the name`)
    load()
  }

  if (loading) return null

  return (
    <Panel
      label="Custom categories"
      flush
      action={
        available && (
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => {
              setForm(EMPTY_FORM)
              setFormError(null)
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
            Custom categories need <Code>supabase/migrations/030_categories.sql</Code>. Run it in the Supabase SQL editor
            and this section starts working.
          </Notice>
        </div>
      ) : rows.length === 0 ? (
        <p className="p-3 lg:p-4 text-body-sm text-muted">
          Nothing yet. Add a name the built-in list is missing. It shows up in every category picker and on the Budget
          breakdown.
        </p>
      ) : (
        <ListRows as="ul" label="Custom categories">
          {rows.map((row) => (
            <ListRow
              key={row.id}
              as="li"
              leading={
                <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-chip bg-surface-2 text-muted">
                  <Icon name={row.icon ? resolveIcon(row.icon) : getCategoryIcon(row.name)} size={16} />
                </span>
              }
              title={row.name}
              trailing={
                <IconButton
                  name="trash"
                  label={`Delete category ${row.name}`}
                  onClick={() => handleDelete(row)}
                  disabled={deletingId === row.id}
                  className="-mr-2"
                />
              }
            />
          ))}
        </ListRows>
      )}

      {available && (
        <p className="px-3 py-2.5 lg:px-4 text-body-sm text-muted border-t border-border">
          The email sync files into built-in categories only, so it never invents a name. To route synced transactions
          here, add a category rule above that points at it.
        </p>
      )}

      <Sheet isOpen={showForm} onClose={closeForm} title="New category" desktopCenter>
        <SheetHeader title="New category" onClose={closeForm} />
        <form onSubmit={handleSave} className="p-4 space-y-4 overflow-y-auto">
          <Input
            id="category-name"
            label="Name"
            value={form.name}
            maxLength={NAME_MAX}
            autoFocus
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }))
              if (formError) setFormError(null)
            }}
            placeholder="Pets"
            error={formError}
          />

          <div className="space-y-1.5">
            <Label as="p">Icon</Label>
            <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
              {CUSTOM_CATEGORY_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, icon }))}
                  aria-pressed={form.icon === icon}
                  aria-label={`Icon ${icon}`}
                  className={`press w-12 h-12 flex items-center justify-center rounded-control border transition-colors ${
                    form.icon === icon
                      ? 'bg-surface-2 border-border-strong text-foreground'
                      : 'bg-card border-border text-muted hover:text-foreground'
                  }`}
                >
                  <Icon name={icon} size={20} />
                </button>
              ))}
            </div>
          </div>

          <Button type="submit" full loading={saving}>
            {saving ? 'Saving…' : 'Add category'}
          </Button>
        </form>
      </Sheet>
    </Panel>
  )
}
