import { Link } from 'react-router-dom'

/**
 * A row inside a flush Panel (rows separate with the Panel body's
 * `divide-y divide-border`; wrap them in <ListRows>). 48px tall, 56px with a
 * subtitle; 12px side padding. The title truncates; `trailing` never shrinks,
 * so an amount is never cut. Interactive rows (onClick or to) render a
 * button or Link and change surface to surface-2 when pressed; no scale.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.leading] - a CategoryMark, StatusDot or checkbox
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} [props.subtitle] - body-sm, muted; truncates unless `wrap`
 * @param {boolean} [props.wrap] - let the subtitle wrap to two lines (a sentence, not a label)
 * @param {React.ReactNode} [props.meta] - a data-step line under the subtitle (Provenance)
 * @param {React.ReactNode} [props.trailing] - an amount, a chevron, a small button
 * @param {() => void} [props.onClick]
 * @param {string} [props.to]
 * @param {boolean} [props.isNew] - inserted after mount: fades and moves 4px in once
 * @param {string} [props.label] - accessible name when the visible text is not enough
 */
export default function ListRow({ leading, title, subtitle, meta, trailing, onClick, to, isNew = false, wrap = false, label, as: As = 'div' }) {
  const tall = subtitle || meta
  const body = (
    <>
      {leading && <span className="shrink-0 flex items-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-body text-foreground truncate">{title}</span>
        {subtitle && <span className={`block text-body-sm text-muted ${wrap ? 'line-clamp-2' : 'truncate'}`}>{subtitle}</span>}
        {meta && <span className="block type-data text-muted-dim truncate">{meta}</span>}
      </span>
      {trailing && <span className="shrink-0 flex items-center gap-2 text-right text-body">{trailing}</span>}
    </>
  )
  const base = `flex items-center gap-3 w-full px-3 py-2 text-left ${tall ? 'min-h-14' : 'min-h-12'} ${isNew ? 'row-enter' : ''}`
  const interactive = 'transition-colors duration-150 hover:bg-surface-2 active:bg-surface-2'
  if (to) {
    return (
      <Link to={to} aria-label={label} className={`${base} ${interactive}`}>
        {body}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-label={label} className={`${base} ${interactive}`}>
        {body}
      </button>
    )
  }
  return <As className={base}>{body}</As>
}

/**
 * The list wrapper for rows in a flush Panel: dividers between rows, none
 * around them (the Panel border is the outer edge).
 */
export function ListRows({ children, as: As = 'div', label }) {
  return (
    <As aria-label={label} className="divide-y divide-border">
      {children}
    </As>
  )
}
