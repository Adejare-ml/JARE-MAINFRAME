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
    <div className="bg-card rounded-3xl p-8 border border-red-500/20 text-center space-y-4">
      <span className="text-4xl" aria-hidden="true">📡</span>
      <div>
        <p className="text-base font-bold text-white mb-1">Couldn't load your data</p>
        <p className="text-xs text-muted max-w-xs mx-auto">
          {message || 'Check your connection. Nothing was lost — this screen just could not reach the database.'}
        </p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-6 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] hover:bg-accent/90 transition-colors"
        >
          Try again
        </button>
      )}
    </div>
  )
}
