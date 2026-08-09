import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { probeSchema, pendingMigrations } from '../lib/schema'

/**
 * Find out what the database has, once, before anything queries it.
 *
 * Deliberately run alongside the session restore in App rather than as its own
 * blocking step. The app already shows "Loading Mainframe…" while
 * `supabase.auth.getSession()` resolves; the probe overlaps that wait, so the
 * common case costs no perceived latency at all — and no page ever issues a
 * query before the answer is known, which is what would reintroduce the bug
 * this whole mechanism exists to prevent.
 *
 * @returns {{checking: boolean, pending: string[]}}
 */
export function useSchemaCheck() {
  const [checking, setChecking] = useState(true)
  const [pending, setPending] = useState([])

  useEffect(() => {
    let cancelled = false

    probeSchema(supabase)
      .then(() => {
        if (!cancelled) setPending(pendingMigrations())
      })
      .catch((err) => {
        // probeSchema swallows its own errors; this is belt and braces so a
        // surprise here cannot leave the app stuck on the loading spinner.
        console.warn('Schema probe failed:', err?.message || err)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return { checking, pending }
}
