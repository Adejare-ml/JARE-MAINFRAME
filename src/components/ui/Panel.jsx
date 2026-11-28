import Label from './Label'

/**
 * The bordered surface every module sits in, with the mainframe header strip:
 * a mono uppercase label on the left, meta (data step) and an optional action
 * on the right, and a rule below. 1px border, 6px radius, no shadow.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.label] - header label; a string also names the region
 * @param {React.ReactNode} [props.meta] - right-hand data text (a count, a time)
 * @param {React.ReactNode} [props.action] - right-hand control, usually a small Button or link
 * @param {boolean} [props.flush] - no body padding, for ListRow lists
 * @param {'warn'|'danger'} [props.tone] - adds a 2px left rule in that colour
 * @param {string} [props.className] - layout only
 */
export default function Panel({ label, meta, action, flush = false, tone, children, className = '', ...rest }) {
  const rule = tone === 'warn' ? 'border-l-2 border-l-warn' : tone === 'danger' ? 'border-l-2 border-l-danger' : ''
  const hasHeader = label || meta || action
  return (
    <section
      aria-label={typeof label === 'string' ? label : undefined}
      className={`bg-card border border-border rounded-panel overflow-hidden ${rule} ${className}`}
      {...rest}
    >
      {hasHeader && (
        <header className="flex items-center justify-between gap-3 min-h-9 px-3 lg:px-4 border-b border-border">
          {label ? <Label as="h2" className="truncate">{label}</Label> : <span />}
          {(meta || action) && (
            <div className="flex items-center gap-3 shrink-0">
              {meta && <span className="type-data text-muted-dim whitespace-nowrap">{meta}</span>}
              {action}
            </div>
          )}
        </header>
      )}
      <div className={flush ? '' : 'p-3 lg:p-4'}>{children}</div>
    </section>
  )
}
