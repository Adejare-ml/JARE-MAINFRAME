import IconButton from '../ui/IconButton'
import StatusDot from '../ui/StatusDot'

/**
 * Small pieces the Settings sections share, composed from the primitives.
 * Local to this folder: nothing here is a new primitive, only the same three
 * arrangements written once instead of eight times.
 */

/**
 * The top strip of a Settings sheet: the title, and a close control on the
 * right (or a back control on the left while a sheet shows a sub-view such
 * as the category picker). The Sheet itself draws no heading.
 */
export function SheetHeader({ title, onClose, onBack, backLabel = 'Back' }) {
  return (
    <div className="flex items-center gap-1 min-h-12 pl-4 pr-1 border-b border-border shrink-0">
      {onBack && <IconButton name="chevL" label={backLabel} onClick={onBack} className="-ml-3" />}
      <h2 className="flex-1 min-w-0 text-title text-foreground truncate">{title}</h2>
      {onClose && <IconButton name="close" label="Close" onClick={onClose} />}
    </div>
  )
}

/**
 * A setup step or a caution inside a section: an amber dot and a plain
 * sentence. Colour is never the only signal; the sentence says what to do.
 */
export function Notice({ children, status = 'warn' }) {
  return (
    <div className="flex items-start gap-2.5 text-body-sm text-foreground">
      <StatusDot status={status} className="mt-1.5" />
      <p className="min-w-0 break-words">{children}</p>
    </div>
  )
}

/** A file name, command or key the owner has to type somewhere else. */
export function Code({ children }) {
  return <code className="type-data text-foreground break-all">{children}</code>
}
