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
import Segmented from '../ui/Segmented'
import CategoryMark from '../ui/CategoryMark'
import { Field, Input, controlClasses } from '../ui/Field'
import { SheetHeader, Notice, Code } from './parts'

/**
 * The user-editable half of categorization (migration 020).
 *
 * The ingest function (032 onwards) owns the structural facts -- a stamp
 * duty line is a bank charge whoever's account it is. This is the
 * different, personal case: "Netflix is always Subscriptions", which only
 * the person using the app can know, applied by the ingest function in
 * priority order on every alert it records.
 *
 * Self-contained, like CashReconciliation on Daily HQ: its own fetch, its own
 * writes, so a Settings page that already does a lot does not have to grow a
 * sixth thing in its one big Promise.all.
 */

const EMPTY_FORM = { trigger_field: 'recipient', trigger_value: '', action_category: ALL_CATEGORIES[0], priority: '0' }

export default function CategoryRules() {
  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)

  const available = hasColumn('category_rules.trigger_field')

  const load = async () => {
    if (!available) {
      setLoading(false)
      return
    }
    const { data, error } = await supabase
      .from('category_rules')
      .select('*')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
    if (error) console.warn('Could not load category rules:', error.message)
    setRules(error ? [] : data || [])
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
    const trigger_value = form.trigger_value.trim()
    if (!trigger_value) {
      toast.error('What should it look for?')
      return
    }

    setSaving(true)
    const { error } = await supabase.from('category_rules').insert({
      trigger_field: form.trigger_field,
      trigger_value,
      action_category: form.action_category,
      priority: Number(form.priority) || 0,
    })
    setSaving(false)

    if (error) {
      toast.error('Failed to save: ' + error.message)
      return
    }
    toast.success('Rule added')
    closeForm()
    setForm(EMPTY_FORM)
    load()
  }

  const handleDelete = async (id) => {
    setDeletingId(id)
    const { error } = await supabase.from('category_rules').delete().eq('id', id)
    setDeletingId(null)
    if (error) {
      toast.error('Could not delete: ' + error.message)
      return
    }
    setRules((prev) => prev.filter((r) => r.id !== id))
  }

  if (loading) return null

  return (
    <Panel
      label="Category rules"
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
            Category rules need <Code>supabase/migrations/020_category_rules.sql</Code>. Run it in the Supabase SQL editor
            and this section starts working.
          </Notice>
        </div>
      ) : rules.length === 0 ? (
        <p className="p-3 lg:p-4 text-body-sm text-muted">
          Nothing yet. Add one for a merchant the AI keeps miscategorising (recipient contains Netflix, filed under
          Subscriptions) and every future sync files it correctly, checked before the AI&apos;s own guess.
        </p>
      ) : (
        <ListRows as="ul" label="Category rules">
          {rules.map((rule) => (
            <ListRow
              key={rule.id}
              as="li"
              leading={<CategoryMark category={rule.action_category} />}
              title={`${rule.trigger_field} contains "${rule.trigger_value}"`}
              subtitle={`File under ${rule.action_category}`}
              trailing={
                <IconButton
                  name="trash"
                  label={`Delete rule for ${rule.trigger_value}`}
                  onClick={() => handleDelete(rule.id)}
                  disabled={deletingId === rule.id}
                  className="-mr-2"
                />
              }
            />
          ))}
        </ListRows>
      )}

      <Sheet
        isOpen={showForm}
        onClose={closeForm}
        title={showCategoryPicker ? 'File it under' : 'New category rule'}
        desktopCenter
      >
        {/* Swapped in as a view within this same Sheet, rather than a second
            nested one -- see CategoryPickerList's own comment for why. */}
        {showCategoryPicker ? (
          <>
            <SheetHeader title="File it under" onBack={() => setShowCategoryPicker(false)} />
            <div className="p-4 overflow-y-auto">
              <CategoryPickerList
                value={form.action_category}
                onSelect={(action_category) => {
                  setForm((f) => ({ ...f, action_category }))
                  setShowCategoryPicker(false)
                }}
              />
            </div>
          </>
        ) : (
          <>
            <SheetHeader title="New category rule" onClose={closeForm} />
            <form onSubmit={handleSave} className="p-4 space-y-4 overflow-y-auto">
              <Field label="When the">
                {() => (
                  <Segmented
                    full
                    label="Field to check"
                    value={form.trigger_field}
                    onChange={(field) => setForm((f) => ({ ...f, trigger_field: field }))}
                    options={[
                      { value: 'recipient', label: 'Recipient' },
                      { value: 'description', label: 'Description' },
                    ]}
                  />
                )}
              </Field>

              <Input
                id="rule-value"
                label="Contains"
                type="text"
                value={form.trigger_value}
                onChange={(e) => setForm((f) => ({ ...f, trigger_value: e.target.value }))}
                placeholder="Netflix"
              />

              <Field label="File it under">
                {({ id }) => (
                  <button
                    id={id}
                    type="button"
                    onClick={() => setShowCategoryPicker(true)}
                    className={`${controlClasses()} flex items-center gap-2 text-left`}
                  >
                    <CategoryMark category={form.action_category} size="sm" />
                    <span className="truncate">{form.action_category}</span>
                  </button>
                )}
              </Field>

              <Input
                id="rule-priority"
                label="Priority"
                hint="Lower checks first; only matters if two rules could both match."
                type="number"
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              />

              <Button type="submit" full loading={saving}>
                {saving ? 'Saving…' : 'Add rule'}
              </Button>
            </form>
          </>
        )}
      </Sheet>
    </Panel>
  )
}
