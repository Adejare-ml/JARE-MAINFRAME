/**
 * One shape for a loading placeholder: a static surface-2 block. No shimmer
 * (docs/design-system.md, "Motion"). `className` carries the size/shape the
 * call site needs.
 *
 * `aria-hidden`: a placeholder block has nothing for a screen reader to
 * announce. The page around it is still responsible for its own loading
 * state being announced once.
 */
export default function Skeleton({ className = '' }) {
  const fill = /(^|\s)bg-/.test(className) ? '' : 'bg-surface-2 '
  return <div className={`${fill}rounded-control ${className}`} aria-hidden="true" />
}

/** `count` copies of the same skeleton row. */
export function SkeletonRows({ count = 3, className = '' }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={className} />
      ))}
    </>
  )
}
