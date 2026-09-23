import { getCategoryIcon } from '../../lib/constants'
import { groupedCategories } from '../../lib/categories'

/**
 * The icon + label grid itself, grouped by section -- no Sheet, no backdrop.
 *
 * Split out from CategoryPickerSheet so a form already rendered inside its
 * own open Sheet (GoalForm, CategoryRules) can swap this in as an internal
 * view rather than opening a second, nested Sheet. Two Sheets open at once
 * would each register their own Escape/back-gesture handling
 * (useDismissable), and a single Escape press or back gesture would then
 * close both at once instead of just the picker -- not a second dialog
 * stacked on the first. CategoryPickerSheet wraps this for callers with no
 * such ancestor (Transactions' inline and bulk editors), where opening a
 * real Sheet is exactly right.
 *
 * @param {object} props
 * @param {string} props.value
 * @param {(category: string) => void} props.onSelect
 * @param {boolean} [props.allowNone]
 * @param {string} [props.noneLabel]
 */
export default function CategoryPickerList({ value, onSelect, allowNone = false, noneLabel = 'Any category' }) {
  return (
    <div className="space-y-4">
      {allowNone && (
        <button
          type="button"
          onClick={() => onSelect('')}
          aria-pressed={!value}
          className={`w-full flex items-center gap-2 p-3 rounded-xl border text-left text-xs font-medium transition-all min-h-[48px] ${
            !value
              ? 'bg-accent/20 border-accent text-white font-bold'
              : 'bg-white/5 border-white/5 text-muted hover:text-white hover:bg-white/10'
          }`}
        >
          <span className="text-lg" aria-hidden="true">∅</span>
          <span>{noneLabel}</span>
        </button>
      )}

      {Object.entries(groupedCategories()).map(([section, cats]) => (
        <div key={section} className="space-y-2">
          <h4 className="text-[11px] font-bold text-muted-dim uppercase tracking-widest">{section}</h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {cats.map((cat) => {
              const isSelected = value === cat
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => onSelect(cat)}
                  aria-pressed={isSelected}
                  className={`flex items-center gap-2 p-3 rounded-xl border text-left text-xs font-medium transition-all min-h-[48px] ${
                    isSelected
                      ? 'bg-accent/20 border-accent text-white font-bold'
                      : 'bg-white/5 border-white/5 text-muted hover:text-white hover:bg-white/10'
                  }`}
                >
                  <span className="text-lg" aria-hidden="true">{getCategoryIcon(cat)}</span>
                  <span className="truncate">{cat}</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
