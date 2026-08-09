/**
 * What a page looks like while its chunk is downloading.
 *
 * Deliberately the same shape as the loading states already written into
 * DailyHQ and Budget -- a title bar, a hero card, a list -- so a lazy route
 * arriving is a skeleton settling into content rather than a spinner being
 * replaced by a different-shaped skeleton.
 */
export default function PageSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-hidden="true">
      <div className="space-y-2">
        <div className="h-8 bg-white/5 rounded-xl w-48" />
        <div className="h-4 bg-white/5 rounded-lg w-64" />
      </div>
      <div className="h-32 bg-card rounded-3xl border border-white/5" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[1, 2, 3].map((n) => (
          <div key={n} className="h-24 bg-card rounded-2xl border border-white/5" />
        ))}
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="h-16 bg-card rounded-2xl border border-white/5" />
        ))}
      </div>
      <span className="sr-only">Loading page…</span>
    </div>
  )
}
