import Panel from '../ui/Panel'
import Icon from '../ui/Icon'
import { buttonClasses } from '../ui/Button'

// Small pieces the Diet sheets share, built from the design-system tokens.
/**
 * A Panel for a step inside a sheet: `padded` stacks its children with the
 * panel's padding, otherwise the body is flush for rows.
 */
export function SheetBox({ label, meta, ariaLabel, padded = false, children }) {
  return (
    <Panel label={label} meta={meta} flush={!padded} aria-label={ariaLabel || (typeof label === 'string' ? label : undefined)}>
      {padded ? <div className="space-y-3">{children}</div> : children}
    </Panel>
  )
}

/** One quick pick in a row of them: the pressed one shows a check glyph and a stronger border, not colour alone. */
export function Choice({ selected, onClick, children }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={`${buttonClasses({ variant: 'secondary', size: 'sm' })} ${selected ? '!border-border-strong' : '!text-muted'}`}>
      {selected && <Icon name="check" size={16} />}
      {children}
    </button>
  )
}
