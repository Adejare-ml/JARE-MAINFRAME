import { useState, useEffect } from 'react'
import Sheet from '../ui/Sheet'
import { GOAL_ICONS, getCategoryIcon } from '../../lib/constants'
import { formatGoalAmount } from '../../lib/formatters'
import { hasColumn } from '../../lib/schema'
import { startOfMonth, startOfWeek, endOfMonth, toDateOnly } from '../../lib/queries'
import { decomposeMonthly, decomposeWeekly, weeksRemaining, REPO_METRIC } from '../../lib/planning'
import CategoryPickerList from '../ui/CategoryPickerList'

/**
 * Create or edit a monthly or weekly goal.
 *
 * The part that earns its place is the preview at the bottom. A target of
 * ₦150,000 by the end of August is a number you can agree to without having any
 * idea what you have agreed to; "₦37,500 a week, ₦5,357 a day" is the same
 * commitment stated in the units you will actually meet it in. It is computed by
 * the same functions the generator will use in Stage 4 -- not a re-implementation
 * -- because a preview that disagrees with what the app later asks of you is
 * worse than no preview.
 *
 * Modal shape, dismissal and field classes follow src/pages/Debts.jsx so this
 * looks like the rest of the app rather than like a second app.
 */

const METRICS = [
  {
    id: 'manual',
    label: 'Just a reminder',
    hint: 'You tick it off yourself.',
  },
  {
    id: 'save_at_least',
    label: 'Save at least',
    hint: 'Counts credits into the chosen category. Ticks itself.',
  },
  {
    id: 'spend_under',
    label: 'Spend under',
    hint: 'Counts debits, ignoring transfers between your own wallets.',
  },
  {
    id: REPO_METRIC,
    label: 'Ship commits',
    hint: 'Counted from the repository each night. A quiet day is not a failed one.',
    // Arrives with 010, and unlike the other three it cannot degrade gracefully:
    // `goals_metric_valid` refuses the value outright, so offering it against a
    // database that has not caught up produces a 23514 on save and nothing else.
    needs: 'goals.evidence',
  },
]

/** True for a goal whose evidence comes from a repository, not the ledger. */
const isRepo = (metric) => metric === REPO_METRIC

const EMPTY = {
  title: '',
  period: 'monthly',
  metric: 'save_at_least',
  target_amount: '',
  metric_category: 'Savings',
  metric_wallet_id: '',
  icon: '',
  locked: false,
}

/**
 * The first thing wrong with the form, phrased as something a person would say.
 *
 * Mirrors migration 009's `goals_metric_needs_target` check. The database will
 * refuse the same row anyway -- but as SQLSTATE 23514 naming a constraint,
 * which is not an error message, it is a stack trace wearing one.
 *
 * Returns a string rather than a list because this asks one question at a
 * time: the first thing wrong, not everything wrong at once. Shown inline
 * next to the field it concerns, phrased as a question. See Debts' "Who is
 * this with?".
 *
 * @returns {string|null}
 */
export function validateGoal(form) {
  const title = (form?.title || '').trim()

  if (!title) return 'What should this goal be called?'
  if (title.length > 120) return 'That name is too long to fit on a card'

  if (form.metric !== 'manual') {
    const amount = Number(form.target_amount)
    if (!form.target_amount || Number.isNaN(amount) || amount <= 0) {
      return isRepo(form.metric)
        ? 'How many commits? A measured goal needs a number above zero'
        : 'How much? A measured goal needs an amount above zero'
    }
    // A repo goal is measured by the repository, which is configuration rather
    // than a column on the row -- so it satisfies the rule by being what it is.
    // 010 amends the database check in exactly this shape; the two have to agree
    // or the form refuses rows the database would take, or the reverse.
    if (!isRepo(form.metric) && !form.metric_category && !form.metric_wallet_id) {
      return 'Pick a category or a wallet, so it knows what to measure'
    }
    if (isRepo(form.metric) && !Number.isInteger(amount)) {
      return 'Commits come in whole numbers'
    }
  }

  return null
}

export default function GoalForm({ open, editing, wallets = [], onClose, onSave, saving }) {
  const [form, setForm] = useState(EMPTY)
  // Inline, next to the field, instead of a full-width toast banner -- paired
  // with a brief shake on the form itself.
  const [formError, setFormError] = useState(null)
  const [shake, setShake] = useState(false)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)

  useEffect(() => {
    // Always, not just on open: this component stays mounted while closed
    // (`if (!open) return null` below, not an unmount), so without this the
    // picker view from a previous session would still be showing the next
    // time the sheet opens.
    setShowCategoryPicker(false)
    if (!open) return
    setForm(
      editing
        ? {
            title: editing.title || '',
            period: editing.period || 'monthly',
            metric: editing.metric || 'manual',
            target_amount: editing.target_amount == null ? '' : String(editing.target_amount),
            metric_category: editing.metric_category || '',
            metric_wallet_id: editing.metric_wallet_id || '',
            icon: editing.icon || '',
            locked: Boolean(editing.locked),
          }
        : EMPTY,
    )
  }, [open, editing])

  if (!open) return null

  const set = (patch) => {
    setForm((prev) => ({ ...prev, ...patch }))
    if (formError) setFormError(null)
  }

  const handleSubmit = (e) => {
    e.preventDefault()

    const problem = validateGoal(form)
    if (problem) {
      setFormError(problem)
      setShake(true)
      setTimeout(() => setShake(false), 400)
      return
    }
    setFormError(null)

    onSave({
      title: form.title.trim(),
      period: form.period,
      // The period this goal is FOR, never a free-form deadline. A monthly goal
      // is anchored to the 1st and due when that month ends; a weekly one to
      // its Monday. Uniform across all three cadences, which is what lets the
      // unique index on (period, target_date, slot) mean one set per period.
      target_date: form.period === 'monthly' ? startOfMonth(new Date()) : startOfWeek(new Date()),
      metric: form.metric,
      // Nulled rather than left behind, so switching a goal back to a plain
      // reminder does not keep measuring it against a category you forgot about.
      // A repo goal nulls them for the same reason: it is measured by the
      // repository, and a leftover category would put a category name on a card
      // about code.
      target_amount: form.metric === 'manual' ? null : Number(form.target_amount),
      metric_category:
        form.metric === 'manual' || isRepo(form.metric) ? null : form.metric_category || null,
      metric_wallet_id:
        form.metric === 'manual' || isRepo(form.metric) ? null : form.metric_wallet_id || null,
      generated: false,
      // Omitted rather than sent as null on a database behind 019/022:
      // PostgREST rejects an insert/update naming a column it does not have
      // (PGRST204) for the whole row, not just this field.
      ...(hasColumn('goals.icon') ? { icon: form.icon || null } : {}),
      ...(hasColumn('goals.locked') ? { locked: form.locked } : {}),
      ...(editing ? { id: editing.id } : {}),
    })
  }

  const preview = buildPreview(form)

  return (
    <Sheet isOpen={open} onClose={onClose} title={editing ? 'Edit goal' : 'New goal'} desktopCenter>
      <form
        onSubmit={handleSubmit}
        className={`p-6 space-y-4 overflow-y-auto ${shake ? 'animate-shake' : ''}`}
      >
        {/* Swapped in as a view within this same Sheet, rather than a second
            nested one -- see CategoryPickerList's own comment for why two
            Sheets open at once is the wrong shape here. */}
        {showCategoryPicker ? (
        <>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">Measured on category</h2>
          <button
            type="button"
            onClick={() => setShowCategoryPicker(false)}
            className="text-sm font-semibold text-muted hover:text-white min-h-[44px] px-2 flex items-center gap-1"
          >
            ← Back
          </button>
        </div>
        <CategoryPickerList
          value={form.metric_category}
          onSelect={(metric_category) => {
            set({ metric_category })
            setShowCategoryPicker(false)
          }}
          allowNone
          noneLabel="Any category"
        />
        </>
        ) : (
        <>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">{editing ? 'Edit goal' : 'New goal'}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-white/10 text-muted hover:text-white"
          >
            ✕
          </button>
        </div>

        <div>
          <label htmlFor="goal-title" className="block text-xs text-muted mb-1.5">
            What is it?
          </label>
          {formError && (
            <p role="alert" className="text-xs text-red-400 font-medium mb-1.5">
              {formError}
            </p>
          )}
          <input
            id="goal-title"
            type="text"
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="Laptop fund"
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
          />
        </div>

        {hasColumn('goals.icon') && (
          <div>
            <span className="block text-xs text-muted mb-1.5">Icon (optional)</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => set({ icon: '' })}
                aria-pressed={!form.icon}
                aria-label="No icon"
                className={`w-11 h-11 flex items-center justify-center rounded-xl border text-xs transition-colors ${
                  !form.icon
                    ? 'bg-accent/10 border-accent text-accent'
                    : 'bg-background border-white/10 text-muted hover:border-white/20'
                }`}
              >
                None
              </button>
              {GOAL_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => set({ icon })}
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
        )}

        {hasColumn('goals.locked') && (
          <button
            type="button"
            onClick={() => set({ locked: !form.locked })}
            aria-pressed={form.locked}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border text-left transition-colors min-h-[48px] ${
              form.locked
                ? 'bg-amber-500/10 border-amber-500/30'
                : 'bg-background border-white/10 hover:border-white/20'
            }`}
          >
            <span>
              <span className={`block text-sm font-semibold ${form.locked ? 'text-amber-400' : 'text-white'}`}>
                {form.locked ? '🔒 Locked' : 'Lock this goal'}
              </span>
              <span className="block text-[11px] text-muted mt-0.5">
                Asks for confirmation before this can be deleted early. For money you do not want to talk yourself out of.
              </span>
            </span>
          </button>
        )}

        <div>
          <span className="block text-xs text-muted mb-1.5">How often?</span>
          <div className="grid grid-cols-2 gap-2">
            {['monthly', 'weekly'].map((period) => (
              <button
                key={period}
                type="button"
                onClick={() => set({ period })}
                aria-pressed={form.period === period}
                className={`py-3 rounded-xl text-sm font-bold capitalize min-h-[48px] transition-colors ${
                  form.period === period
                    ? 'bg-accent text-black'
                    : 'bg-background border border-white/10 text-muted hover:text-white'
                }`}
              >
                {period}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span className="block text-xs text-muted mb-1.5">How is it measured?</span>
          <div className="space-y-2">
            {METRICS.filter((m) => !m.needs || hasColumn(m.needs)).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => set({ metric: m.id })}
                aria-pressed={form.metric === m.id}
                className={`w-full text-left px-4 py-3 rounded-xl border transition-colors min-h-[48px] ${
                  form.metric === m.id
                    ? 'bg-accent/10 border-accent'
                    : 'bg-background border-white/10 hover:border-white/20'
                }`}
              >
                <span
                  className={`block text-sm font-semibold ${
                    form.metric === m.id ? 'text-accent' : 'text-white'
                  }`}
                >
                  {m.label}
                </span>
                <span className="block text-[11px] text-muted mt-0.5">{m.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {form.metric !== 'manual' && (
          <>
            <div>
              <label htmlFor="goal-amount" className="block text-xs text-muted mb-1.5">
                {isRepo(form.metric)
                  ? 'How many commits?'
                  : form.metric === 'save_at_least'
                    ? 'Save at least (₦)'
                    : 'Stay under (₦)'}
              </label>
              <input
                id="goal-amount"
                type="number"
                inputMode={isRepo(form.metric) ? 'numeric' : 'decimal'}
                min="1"
                step={isRepo(form.metric) ? '1' : 'any'}
                value={form.target_amount}
                onChange={(e) => set({ target_amount: e.target.value })}
                placeholder={isRepo(form.metric) ? '40' : '150000'}
                className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-hint focus:outline-none focus:border-accent min-h-[48px]"
              />
            </div>

            {isRepo(form.metric) && (
              <p className="text-[11px] text-muted bg-background/60 border border-white/10 rounded-xl p-3">
                Checked against the repository each night, and the commits it counted are
                kept on the goal so the figure can be audited. A day with no commits is
                recorded as <span className="text-white">checked and empty</span> — never as
                missed, because office work leaves no trace here. You can still tick one off
                yourself.
              </p>
            )}

            {/* Money only. A repo goal is measured by the repository, so a
                category picker here would be a control with nothing behind
                it -- and one the user would reasonably expect to matter. */}
            {!isRepo(form.metric) && (
              <>
                <div>
                  <label className="block text-xs text-muted mb-1.5">Measured on category</label>
                  <button
                    type="button"
                    onClick={() => setShowCategoryPicker(true)}
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px] flex items-center gap-2"
                  >
                    {form.metric_category ? (
                      <>
                        <span className="text-lg" aria-hidden="true">{getCategoryIcon(form.metric_category)}</span>
                        <span className="truncate">{form.metric_category}</span>
                      </>
                    ) : (
                      <span className="text-muted">— any category —</span>
                    )}
                  </button>
                </div>

                <div>
                  <label htmlFor="goal-wallet" className="block text-xs text-muted mb-1.5">
                    And / or wallet
                  </label>
                  <select
                    id="goal-wallet"
                    value={form.metric_wallet_id}
                    onChange={(e) => set({ metric_wallet_id: e.target.value })}
                    className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
                  >
                    <option value="">— any wallet —</option>
                    {wallets
                      .filter((w) => w.is_active !== false)
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.name}
                        </option>
                      ))}
                  </select>
                </div>
              </>
            )}
          </>
        )}

        {preview && (
          <div className="bg-background/60 border border-white/10 rounded-xl p-4 space-y-1.5">
            <p className="text-[10px] text-muted uppercase tracking-wider">
              What this asks of you
            </p>
            {preview.lines.map((line) => (
              <p key={line} className="text-sm text-white">
                {line}
              </p>
            ))}
            <p className="text-[11px] text-muted pt-1">{preview.note}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={saving}
          className="w-full py-3.5 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
        >
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Create goal'}
        </button>
        </>
        )}
      </form>
    </Sheet>
  )
}

/**
 * The same arithmetic the generator will run, shown before you commit to it.
 *
 * Starts from zero progress deliberately: this is what the goal asks of you as
 * written, not what is left after what you have already done. Showing the
 * latter here would make the number move every time you opened the form.
 */
function buildPreview(form) {
  if (form.metric === 'manual') return null

  const amount = Number(form.target_amount)
  if (!amount || Number.isNaN(amount) || amount <= 0) return null

  const today = toDateOnly(new Date())
  const lines = []

  if (form.period === 'monthly') {
    const anchor = startOfMonth(new Date())
    const goal = {
      id: 'preview',
      period: 'monthly',
      title: form.title || 'this goal',
      target_date: anchor,
      metric: form.metric,
      target_amount: amount,
      metric_category: form.metric_category || null,
      metric_wallet_id: form.metric_wallet_id || null,
    }
    const week = decomposeMonthly(goal, { done: 0 }, today)
    const weeks = weeksRemaining(endOfMonth(new Date()), today)

    if (week) {
      lines.push(`${formatGoalAmount(week.target_amount, form.metric)} a week`)
      const day = decomposeWeekly({ ...week, id: 'preview-week' }, { done: 0 }, today)
      if (day) lines.push(`${formatGoalAmount(day.target_amount, form.metric)} a day`)
    }
    return {
      lines,
      note: `${weeks} week${weeks === 1 ? '' : 's'} left this month. Fall behind and next week's figure goes up, not down.`,
    }
  }

  const goal = {
    id: 'preview',
    period: 'weekly',
    title: form.title || 'this goal',
    target_date: startOfWeek(new Date()),
    metric: form.metric,
    target_amount: amount,
    metric_category: form.metric_category || null,
    metric_wallet_id: form.metric_wallet_id || null,
  }
  const day = decomposeWeekly(goal, { done: 0 }, today)
  if (day) lines.push(`${formatGoalAmount(day.target_amount, form.metric)} a day`)

  return {
    lines,
    note: 'Divided across the days left in this week, not all seven.',
  }
}
