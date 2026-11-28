/**
 * The top of a page: title in the `title` step, optional `data` meta above it
 * (a date, a count), right-hand actions. No hero styling; the page's one
 * `display` figure lives in a Readout, not here.
 *
 * @param {object} props
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} [props.meta]
 * @param {React.ReactNode} [props.actions]
 */
export default function PageHeader({ title, meta, actions }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        {meta && <p className="type-data text-muted-dim mb-0.5 truncate">{meta}</p>}
        <h1 className="text-title text-foreground truncate">{title}</h1>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}
