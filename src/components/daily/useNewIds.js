import { useRef } from 'react'

/**
 * Which ids arrived after the first render, so only a row inserted while the
 * page is open plays the row-insertion motion (`.row-enter`). The initial list
 * never animates (docs/design-system.md, "Motion").
 *
 * @param {Array<string|number>} ids - the ids rendered now
 * @param {boolean} [ready] - false while the first load is in flight, so the
 *   rows that load arrives with count as the initial list
 * @returns {(id: string|number) => boolean}
 */
export function useNewIds(ids, ready = true) {
  const seen = useRef(null)
  if (!ready) return () => false
  if (seen.current === null) seen.current = new Set(ids)
  const fresh = new Set(ids.filter((id) => !seen.current.has(id)))
  // Remember them, so a row animates once and not on every later render.
  for (const id of ids) seen.current.add(id)
  return (id) => fresh.has(id)
}
