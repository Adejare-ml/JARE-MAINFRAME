import Button from './Button'

/**
 * One shape for "there is nothing here yet": one heading line, one body-sm
 * line, one action. No illustration or icon (`icon` is accepted and ignored
 * so existing callers keep working).
 *
 * The action is deliberately singular. A page with nothing to show has
 * exactly one useful next step.
 */
// eslint-disable-next-line no-unused-vars
export default function EmptyState({ icon, title, message, actionLabel, onAction }) {
  return (
    <div className="text-center py-10 px-4">
      <p className="text-heading text-foreground">{title}</p>
      {message && <p className="text-body-sm text-muted max-w-xs mx-auto mt-1">{message}</p>}
      {actionLabel && onAction && (
        <div className="mt-5">
          <Button onClick={onAction}>{actionLabel}</Button>
        </div>
      )}
    </div>
  )
}
