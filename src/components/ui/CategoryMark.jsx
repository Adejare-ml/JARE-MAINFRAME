import { getCategoryIcon } from '../../lib/constants'
import Icon from './Icon'

/**
 * A category's glyph: 16px in muted, inside a 28px surface-2 tile. Sits beside
 * the plain category name (the caller renders the name). No codes, no colour.
 *
 * @param {object} props
 * @param {string} props.category - a category name (built-in or custom)
 * @param {'md'|'sm'} [props.size] - md is the 28px tile, sm a bare 16px glyph
 */
export default function CategoryMark({ category, size = 'md' }) {
  const name = getCategoryIcon(category)
  if (size === 'sm') return <Icon name={name} size={16} className="text-muted" />
  return (
    <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-chip bg-surface-2 text-muted">
      <Icon name={name} size={16} />
    </span>
  )
}
