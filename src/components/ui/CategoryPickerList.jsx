import { groupedCategories } from '../../lib/categories'
import CategoryMark from './CategoryMark'
import Label from './Label'
import Icon from './Icon'

/**
 * The glyph + label grid itself, grouped by section -- no Sheet, no backdrop.
 *
 * Split out from CategoryPickerSheet so a form already rendered inside its
 * own open Sheet (GoalForm, CategoryRules) can swap this in as an internal
 * view rather than opening a second, nested Sheet (two would each handle
 * Escape and the back gesture, and one press would close both).
 *
 * @param {object} props
 * @param {string} props.value
 * @param {(category: string) => void} props.onSelect
 * @param {boolean} [props.allowNone]
 * @param {string} [props.noneLabel]
 */
const option = (selected) =>
  `flex items-center gap-2.5 px-2.5 min-h-12 rounded-control border text-left text-body-sm transition-colors duration-150 ${
    selected
      ? 'bg-surface-2 border-accent text-foreground font-semibold'
      : 'bg-card border-border text-foreground hover:bg-surface-2'
  }`

export default function CategoryPickerList({ value, onSelect, allowNone = false, noneLabel = 'Any category' }) {
  return (
    <div className="space-y-4">
      {allowNone && (
        <button type="button" onClick={() => onSelect('')} aria-pressed={!value} className={`w-full ${option(!value)}`}>
          <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-chip bg-surface-2 text-muted">
            <Icon name="close" size={16} />
          </span>
          <span>{noneLabel}</span>
          {!value && <Icon name="check" size={16} className="ml-auto text-accent" />}
        </button>
      )}

      {Object.entries(groupedCategories()).map(([section, cats]) => (
        <div key={section} className="space-y-2">
          <Label as="h4" className="block">{section}</Label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {cats.map((cat) => {
              const isSelected = value === cat
              return (
                <button key={cat} type="button" onClick={() => onSelect(cat)} aria-pressed={isSelected} className={option(isSelected)}>
                  <CategoryMark category={cat} />
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
