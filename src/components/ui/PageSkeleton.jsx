import Skeleton, { SkeletonRows } from './Skeleton'

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

/**
 * Six pages hand-rolled their own loading placeholder independently, each a
 * few divs sized to that page's own content. Colocated here rather than
 * redesigned into one shared shape: moved verbatim from each page's own
 * `if (loading)` block, same classNames, same structure, so this is a
 * location change only -- nothing here needed a browser to verify, unlike a
 * genuine shared abstraction covering six different content shapes would.
 */

export function DailyHQSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <Skeleton className="h-10 bg-white/5 rounded-xl w-64" />
      <Skeleton className="h-32 bg-card rounded-3xl border border-white/5" />
      <Skeleton className="h-28 bg-card rounded-3xl border border-white/5" />
      <Skeleton className="h-44 bg-card rounded-3xl border border-white/5" />
    </div>
  )
}

export function BudgetSkeleton() {
  return (
    <div className="p-4 md:p-8 animate-pulse space-y-6">
      <Skeleton className="h-10 bg-white/5 rounded w-1/3" />
      <Skeleton className="h-32 bg-white/5 rounded-2xl" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SkeletonRows count={3} className="h-24 bg-white/5 rounded-2xl" />
      </div>
    </div>
  )
}

export function GoalsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <Skeleton className="h-10 bg-white/5 rounded-xl w-48" />
      <Skeleton className="h-24 bg-card rounded-3xl border border-white/5" />
      <Skeleton className="h-44 bg-card rounded-3xl border border-white/5" />
    </div>
  )
}

export function DebtsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <Skeleton className="h-10 bg-white/5 rounded-xl w-48" />
      <Skeleton className="h-24 bg-card rounded-3xl border border-white/5" />
      <Skeleton className="h-44 bg-card rounded-3xl border border-white/5" />
    </div>
  )
}

export function ProjectsSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <Skeleton className="h-10 bg-white/5 rounded-xl w-48" />
      <Skeleton className="h-20 bg-card rounded-3xl border border-white/5" />
      <div className="space-y-3">
        <SkeletonRows count={3} className="h-28 bg-card rounded-2xl border border-white/5" />
      </div>
    </div>
  )
}

export function TransactionsSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <Skeleton className="h-8 bg-white/5 rounded-xl w-48" />
      <Skeleton className="h-12 bg-card rounded-2xl border border-white/5" />
      <div className="space-y-2">
        <SkeletonRows count={5} className="h-16 bg-card rounded-2xl border border-white/5" />
      </div>
    </div>
  )
}

export function SettingsSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <Skeleton className="h-40 bg-card rounded-3xl border border-white/5" />
      <Skeleton className="h-40 bg-card rounded-3xl border border-white/5" />
      <Skeleton className="h-28 bg-card rounded-3xl border border-white/5" />
    </div>
  )
}
