import { Link } from 'react-router-dom'
import Icon from './Icon'

/**
 * A glyph-only control with a 48px square hit area. `label` is required: it
 * is the accessible name (and the tooltip), because the glyph says nothing
 * to a screen reader.
 *
 * @param {object} props
 * @param {string} props.name - glyph name
 * @param {string} props.label - aria-label, required
 * @param {'ghost'|'secondary'|'primary'} [props.variant]
 * @param {string} [props.to] - render as a Link
 */
const VARIANT = {
  ghost: 'text-muted hover:text-foreground hover:bg-surface-2',
  secondary: 'bg-surface-2 text-foreground border border-border hover:border-border-strong',
  primary: 'bg-accent text-on-accent',
}

export default function IconButton({ name, label, variant = 'ghost', to, type = 'button', className = '', size = 20, ...rest }) {
  const classes = `press inline-flex items-center justify-center w-12 h-12 shrink-0 rounded-control disabled:opacity-50 ${VARIANT[variant] || VARIANT.ghost} ${className}`
  if (to) {
    return (
      <Link to={to} aria-label={label} title={label} className={classes} {...rest}>
        <Icon name={name} size={size} />
      </Link>
    )
  }
  return (
    <button type={type} aria-label={label} title={label} className={classes} {...rest}>
      <Icon name={name} size={size} />
    </button>
  )
}
