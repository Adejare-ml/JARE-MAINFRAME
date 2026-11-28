import Panel from './Panel'
import Button from './Button'
import StatusDot from './StatusDot'

/**
 * What a failed page load looks like.
 *
 * Every page used to render a failed fetch as an empty dataset -- "Total:
 * ₦0.00", "All clear!", or in Budget's case the first-run setup screen. On
 * mobile data that is worse than an error: it is a wrong answer delivered
 * confidently.
 */
export default function ErrorState({ message, onRetry }) {
  return (
    <Panel tone="danger">
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-heading text-foreground">
          <StatusDot status="danger" />
          Couldn't load your data
        </p>
        <p className="text-body-sm text-muted">
          {message || 'Check your connection. Nothing was lost. This screen could not reach the database.'}
        </p>
        {onRetry && (
          <Button variant="secondary" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </Panel>
  )
}
