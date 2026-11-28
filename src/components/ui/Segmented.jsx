/**
 * A filter or tab control with a sliding indicator. Replaces pill-chip rows.
 * Equal-width segments, each a full 48px target; the indicator moves by
 * transform over --dur-state.
 *
 * With `tabs`, segments are role="tab" (pass `idPrefix` so each can name its
 * panel: `${idPrefix}-tab-${value}` controls `${idPrefix}-panel-${value}`);
 * otherwise they are toggle buttons with aria-pressed.
 *
 * @param {object} props
 * @param {Array<{value: string, label: React.ReactNode}>} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @param {string} [props.label] - accessible name for the group
 * @param {boolean} [props.tabs]
 * @param {string} [props.idPrefix]
 * @param {boolean} [props.full] - stretch to the container's width
 */
export default function Segmented({ options, value, onChange, label, tabs = false, idPrefix = 'seg', full = false }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value))
  const n = options.length || 1
  return (
    <div
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      className={`relative ${full ? 'flex w-full' : 'inline-flex'} h-12 bg-surface-2 border border-border rounded-control`}
    >
      <span
        aria-hidden="true"
        className="segmented-indicator absolute top-0 bottom-0 left-0 p-1"
        style={{ width: `${100 / n}%`, transform: `translateX(${index * 100}%)` }}
      >
        <span className="block h-full w-full bg-card border border-border-strong rounded-chip" />
      </span>
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            id={tabs ? `${idPrefix}-tab-${o.value}` : undefined}
            role={tabs ? 'tab' : undefined}
            aria-selected={tabs ? selected : undefined}
            aria-controls={tabs ? `${idPrefix}-panel-${o.value}` : undefined}
            aria-pressed={tabs ? undefined : selected}
            onClick={() => onChange(o.value)}
            className={`relative z-10 flex-1 min-w-14 px-3 text-body-sm font-semibold transition-colors duration-150 ${
              selected ? 'text-foreground' : 'text-muted hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
