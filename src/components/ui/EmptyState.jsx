/**
 * One shape for "there is nothing here yet," used instead of every page
 * writing its own. What differs between pages is the icon, the words, and
 * the one thing worth doing about it -- never the layout.
 *
 * The action is deliberately singular. A page with nothing to show has
 * exactly one useful next step; a list of them is the empty state hedging.
 */
export default function EmptyState({ icon = '📭', title, message, actionLabel, onAction }) {
  return (
    <div className="text-center py-16 px-6">
      <div className="text-5xl mb-4" aria-hidden="true">
        {icon}
      </div>
      <p className="text-white font-bold text-base mb-1.5">{title}</p>
      {message && <p className="text-muted text-sm max-w-xs mx-auto">{message}</p>}
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-6 px-6 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  )
}
