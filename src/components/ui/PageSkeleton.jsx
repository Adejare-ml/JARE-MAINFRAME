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
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <div className="h-8 bg-surface-2 rounded-xl w-48" />
        <div className="h-4 bg-surface-2 rounded-lg w-64" />
      </div>
      <div className="h-32 bg-card rounded-3xl border border-border" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[1, 2, 3].map((n) => (
          <div key={n} className="h-24 bg-card rounded-2xl border border-border" />
        ))}
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4].map((n) => (
          <div key={n} className="h-16 bg-card rounded-2xl border border-border" />
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
    <div className="space-y-3" aria-hidden="true">
      <div className="flex items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-6 w-48" />
        </div>
        <Skeleton className="h-12 w-32" />
      </div>
      <Skeleton className="h-48 bg-card border border-border rounded-panel" />
      <Skeleton className="h-40 bg-card border border-border rounded-panel" />
      <Skeleton className="h-36 bg-card border border-border rounded-panel" />
    </div>
  )
}

export function BudgetSkeleton() {
  return (
    <div className="p-4 md:p-8 space-y-6">
      <Skeleton className="h-10 bg-surface-2 rounded w-1/3" />
      <Skeleton className="h-32 bg-surface-2 rounded-2xl" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SkeletonRows count={3} className="h-24 bg-surface-2 rounded-2xl" />
      </div>
    </div>
  )
}

export function GoalsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 bg-surface-2 rounded-xl w-48" />
      <Skeleton className="h-24 bg-card rounded-3xl border border-border" />
      <Skeleton className="h-44 bg-card rounded-3xl border border-border" />
    </div>
  )
}

export function DebtsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 bg-surface-2 rounded-xl w-48" />
      <Skeleton className="h-24 bg-card rounded-3xl border border-border" />
      <Skeleton className="h-44 bg-card rounded-3xl border border-border" />
    </div>
  )
}

export function ProjectsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 bg-surface-2 rounded-xl w-48" />
      <Skeleton className="h-20 bg-card rounded-3xl border border-border" />
      <div className="space-y-3">
        <SkeletonRows count={3} className="h-28 bg-card rounded-2xl border border-border" />
      </div>
    </div>
  )
}

export function RepairsSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 bg-surface-2 rounded-xl w-48" />
      <Skeleton className="h-12 bg-card rounded-2xl border border-border" />
      <Skeleton className="h-20 bg-card rounded-2xl border border-border" />
      <div className="space-y-3">
        <SkeletonRows count={3} className="h-24 bg-card rounded-2xl border border-border" />
      </div>
    </div>
  )
}

export function TransactionsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 bg-surface-2 rounded-xl w-48" />
      <Skeleton className="h-12 bg-card rounded-2xl border border-border" />
      <div className="space-y-2">
        <SkeletonRows count={5} className="h-16 bg-card rounded-2xl border border-border" />
      </div>
    </div>
  )
}

export function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-40 bg-card rounded-3xl border border-border" />
      <Skeleton className="h-40 bg-card rounded-3xl border border-border" />
      <Skeleton className="h-28 bg-card rounded-3xl border border-border" />
    </div>
  )
}
