/**
 * The app's own state, fetched once for everyone who shows it.
 *
 * One provider, mounted in Layout, reads recent sync_runs rows and turns
 * them into the status rail (src/lib/systemStatus.js). Daily HQ reads the
 * same rows from here instead of its own query. Refetches on mount and when
 * the tab becomes visible again, at most every five minutes; tracks
 * online/offline. No money passes through here, so zen mode is unaffected.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase.js'
import { hasColumn } from './schema.js'
import { railState, latestRun } from './systemStatus.js'

export const REFRESH_MIN_MS = 5 * 60 * 1000
/** Same window as Settings → System, so the month plan stays in view mid-month. */
const WINDOW_MS = 35 * 24 * 60 * 60 * 1000

const SystemStatusContext = createContext(null)

function useSystemStatusSource() {
  const available = hasColumn('sync_runs.job')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(available)
  const [failed, setFailed] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false))
  const [pulseKey, setPulseKey] = useState(0)
  const lastFetch = useRef(0)
  const lastSeen = useRef(null)

  const fetchRuns = useCallback(async (force = false) => {
    if (!available) return
    if (!force && Date.now() - lastFetch.current < REFRESH_MIN_MS) return
    lastFetch.current = Date.now()
    const { data, error } = await supabase
      .from('sync_runs')
      .select('job, finished_at, ok, summary')
      .gte('finished_at', new Date(Date.now() - WINDOW_MS).toISOString())
      .order('finished_at', { ascending: false })
    if (error) {
      console.warn('System status unavailable:', error.message)
      setFailed(true)
    } else {
      const next = data || []
      const newest = latestRun(next)
      // A run finished since we last looked, while the app is open: pulse once.
      if (lastSeen.current && newest && newest > lastSeen.current) setPulseKey((k) => k + 1)
      lastSeen.current = newest || lastSeen.current
      setFailed(false)
      setRows(next)
    }
    setLoading(false)
  }, [available])

  useEffect(() => {
    fetchRuns(true)
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchRuns(false)
    }
    const goOnline = () => {
      setOnline(true)
      fetchRuns(true)
    }
    const goOffline = () => setOnline(false)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [fetchRuns])

  return useMemo(() => {
    const rail = railState({ available, loading, offline: !online || failed, rows })
    return { available, loading, rows, failed, online, pulseKey, rail, refresh: () => fetchRuns(true) }
  }, [available, loading, rows, failed, online, pulseKey, fetchRuns])
}

/** Mount once, in Layout. */
export function SystemStatusProvider({ children }) {
  const value = useSystemStatusSource()
  return createElement(SystemStatusContext.Provider, { value }, children)
}

/**
 * The shared status. Outside a provider (a test, the /__kit page) it returns
 * an inert "not migrated" state rather than throwing.
 */
export function useSystemStatus() {
  return (
    useContext(SystemStatusContext) || {
      available: false,
      loading: false,
      rows: [],
      failed: false,
      online: true,
      pulseKey: 0,
      rail: { show: false, status: null, text: '', jobs: [] },
      refresh: () => {},
    }
  )
}
