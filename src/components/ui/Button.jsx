import { Link } from 'react-router-dom'
import Icon from './Icon'

/**
 * The one button. Press scales to 0.98 (`.press`, off under reduced motion).
 *
 *   primary    accent fill, on-accent text (dark text in dark, white in light)
 *   secondary  surface-2 fill with a border
 *   ghost      no fill until pressed or hovered
 *   danger     danger text with a danger border, for destructive actions
 *
 * `md` is 48px high. `sm` is 36px to the eye but keeps a 48px hit area.
 * Pass `to` to render a router Link with the same look.
 *
 * @param {object} props
 * @param {'primary'|'secondary'|'ghost'|'danger'} [props.variant]
 * @param {'md'|'sm'} [props.size]
 * @param {string} [props.icon] - a glyph name, drawn before the text
 * @param {boolean} [props.loading] - spinner, aria-busy, disabled
 * @param {boolean} [props.full] - full width
 * @param {string} [props.to] - render as a Link
 */
const VARIANT = {
  primary: 'bg-accent text-on-accent border border-accent',
  secondary: 'bg-surface-2 text-foreground border border-border hover:border-border-strong',
  ghost: 'bg-transparent text-foreground border border-transparent hover:bg-surface-2',
  danger: 'bg-transparent text-danger border border-danger hover:bg-surface-2',
}

const SIZE = {
  md: 'min-h-12 px-4 text-heading',
  // 36px visual, 48px target: the ::after extends the hit area 6px each way.
  sm: "min-h-9 px-3 text-body-sm font-semibold after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']",
}

export function buttonClasses({ variant = 'primary', size = 'md', full = false } = {}) {
  return `press relative inline-flex items-center justify-center gap-2 rounded-control select-none whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:opacity-50 ${VARIANT[variant] || VARIANT.primary} ${SIZE[size] || SIZE.md} ${full ? 'w-full' : ''}`
}

export function Spinner({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="animate-spin shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export default function Button({
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  full = false,
  to,
  type = 'button',
  disabled,
  className = '',
  children,
  ...rest
}) {
  const classes = `${buttonClasses({ variant, size, full })} ${className}`
  const content = (
    <>
      {loading ? <Spinner size={size === 'sm' ? 14 : 16} /> : icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} /> : null}
      {children}
    </>
  )
  if (to) {
    return (
      <Link to={to} className={classes} {...rest}>
        {content}
      </Link>
    )
  }
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={classes} {...rest}>
      {content}
    </button>
  )
}
