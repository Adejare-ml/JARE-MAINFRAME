import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

/** How long to wait for the change stream to go quiet before refetching. */
const DEFAULT_DELAY_MS = 400

/**
 * Refetch when one of the given tables changes, coalescing bursts.
 *
 * Each page used to subscribe directly and refetch on every `postgres_changes`
 * event. A sync inserting 40 transactions therefore fired 40 full refetches per
 * mounted page -- and since Budget and Daily HQ each ran several queries per
 * refetch, one sync could mean hundreds of round trips to render the same
 * numbers once. Debouncing collapses a burst into a single refetch after the
 * inserts stop.
 *
 * The callback is held in a ref so a page can pass an inline function without
 * tearing down and re-establishing the subscription on every render.
 *
 * @param {string[]} tables - table names to watch
 * @param {() => void} onChange - called after the burst settles
 * @param {{delay?: number, channelPrefix?: string, enabled?: boolean}} [options]
 */
export function useRealtimeRefresh(tables, onChange, options = {}) {
  const { delay = DEFAULT_DELAY_MS, channelPrefix = 'realtime', enabled = true } = options

  const callbackRef = useRef(onChange)
  callbackRef.current = onChange

  // Join, so a change in tables is a value change rather than a new array
  // identity on every render.
  const tableKey = tables.join(',')

  useEffect(() => {
    if (!enabled) return

    const watched = tableKey.split(',').filter(Boolean)
    if (watched.length === 0) return

    let timer = null
    let cancelled = false

    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (!cancelled) callbackRef.current?.()
      }, delay)
    }

    const channels = watched.map((table) =>
      supabase
        .channel(`${channelPrefix}:${table}`)
        .on('postgres_changes', { event: '*', schema: 'public', table }, schedule)
        .subscribe(),
    )

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      for (const channel of channels) supabase.removeChannel(channel)
    }
  }, [tableKey, delay, channelPrefix, enabled])
}
