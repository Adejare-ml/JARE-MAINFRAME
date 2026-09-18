import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { hasColumn } from '../../lib/schema'
import { ALL_CATEGORIES } from '../../lib/constants'
import Sheet from '../ui/Sheet'

/**
 * The user-editable half of categorization (migration 020).
 *
 * applyCategoryOverrides() (src/lib/sync/categorize.js) still owns the
 * structural facts -- a stamp duty line is a bank charge whoever's account it
 * is. This is the different, personal case: "Netflix is always
 * Subscriptions", which only the person using the app can know, checked
 * ahead of those structural facts on the next sync because it is the more
 * specific signal.
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
    toast.success('Rule added ✓')
    setShowForm(false)
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
    <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
      <div className="flex items-center justify-between border-b border-white/5 pb-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
          Category Rules
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
          Category rules need{' '}
          <code className="font-mono text-yellow-200">
            supabase/migrations/020_category_rules.sql
          </code>
          . Run it in the Supabase SQL editor and this section starts working.
        </p>
      ) : rules.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing yet. Add one for a merchant the AI keeps miscategorising --
          "recipient contains Netflix → Subscriptions" -- and every future
          sync files it correctly, checked before the AI's own guess.
        </p>
      ) : (
        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-background/40 border border-white/5"
            >
              <p className="text-xs text-white/90 min-w-0 truncate">
                <span className="text-muted">{rule.trigger_field} contains</span>{' '}
                <span className="font-mono text-white">"{rule.trigger_value}"</span>{' '}
                <span className="text-muted">→</span>{' '}
                <span className="font-semibold text-accent">{rule.action_category}</span>
              </p>
              <button
                type="button"
                onClick={() => handleDelete(rule.id)}
                disabled={deletingId === rule.id}
                aria-label={`Delete rule for ${rule.trigger_value}`}
                className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full hover:bg-red-500/10 text-muted hover:text-red-400 disabled:opacity-50"
              >
                🗑️
              </button>
            </li>
          ))}
        </ul>
      )}

      <Sheet isOpen={showForm} onClose={() => setShowForm(false)} title="New category rule" desktopCenter>
        <form onSubmit={handleSave} className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-white">New category rule</h2>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              aria-label="Close"
              className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-muted hover:text-white"
            >
              ✕
            </button>
          </div>

          <div>
            <span className="block text-xs text-muted mb-1.5">When the</span>
            <div className="grid grid-cols-2 gap-2">
              {['recipient', 'description'].map((field) => (
                <button
                  key={field}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, trigger_field: field }))}
                  aria-pressed={form.trigger_field === field}
                  className={`py-3 rounded-xl text-sm font-bold capitalize min-h-[48px] transition-colors ${
                    form.trigger_field === field
                      ? 'bg-accent text-black'
                      : 'bg-background border border-white/10 text-muted hover:text-white'
                  }`}
                >
                  {field}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="rule-value" className="block text-xs text-muted mb-1.5">
              contains
            </label>
            <input
              id="rule-value"
              type="text"
              value={form.trigger_value}
              onChange={(e) => setForm((f) => ({ ...f, trigger_value: e.target.value }))}
              placeholder="Netflix"
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
            />
          </div>

          <div>
            <label htmlFor="rule-category" className="block text-xs text-muted mb-1.5">
              file it under
            </label>
            <select
              id="rule-category"
              value={form.action_category}
              onChange={(e) => setForm((f) => ({ ...f, action_category: e.target.value }))}
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
            >
              {ALL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="rule-priority" className="block text-xs text-muted mb-1.5">
              Priority (lower checks first; only matters if two rules could both match)
            </label>
            <input
              id="rule-priority"
              type="number"
              value={form.priority}
              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
              className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="w-full py-3.5 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Add rule'}
          </button>
        </form>
      </Sheet>
    </section>
  )
}
