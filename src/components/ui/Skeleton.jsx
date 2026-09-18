/**
 * One shape for a loading placeholder.
 *
 * Six pages used to hand-roll the identical `<div className="bg-white/5
 * rounded-xl ..." />` independently, each free to drift from the others. This
 * is the one definition, sized per use exactly the way those divs already
 * were -- `className` carries the same size/shape classes the call site used
 * to write inline, so replacing a div with this component is a like-for-like
 * swap, not a redesign of any page's loading shape.
 *
 * `aria-hidden`: a placeholder block has nothing for a screen reader to
 * announce. The page around it is still responsible for its own loading
 * state being announced once, not once per block.
 */
export default function Skeleton({ className = '' }) {
  return <div className={className} aria-hidden="true" />
}

/** `count` copies of the same skeleton row -- the repeated-list-row case
 *  (Transactions' five placeholder rows) without writing the .map() at every
 *  call site. */
export function SkeletonRows({ count = 3, className = '' }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className={className} />
      ))}
    </>
  )
}
