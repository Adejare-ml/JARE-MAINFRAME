import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Whether the two edge functions are deployed, from their GET probes.
 *
 * A GET is answered without a model call, so "reachable" means deployed:
 * the one fact about Ask and Meals nothing else in the app can check.
 * Settings → System has always asked; Daily HQ now asks too, for the setup
 * checklist. One answer per session is enough for a deploy that happens
 * once, so the probes run once and both pages read the same promise.
 *
 * Statuses: 'checking' | 'reachable' | 'unreachable' | 'nokey' (meal only:
 * deployed, but neither provider key is set).
 */

let askPromise = null
let mealPromise = null

function probeAsk() {
  if (!askPromise) {
    askPromise = supabase.functions
      .invoke('ask-question', { method: 'GET' })
      .then(({ data, error }) => (!error && data?.ok ? 'reachable' : 'unreachable'))
      .catch(() => 'unreachable')
  }
  return askPromise
}

function probeMeal() {
  if (!mealPromise) {
    mealPromise = supabase.functions
      .invoke('analyze-meal', { method: 'GET' })
      .then(({ data, error }) => {
        if (error || !data?.ok) return 'unreachable'
        return data.providers?.ollama || data.providers?.nvidia ? 'reachable' : 'nokey'
      })
      .catch(() => 'unreachable')
  }
  return mealPromise
}

/** Forget the cached answers, so a test (or a deploy mid-session) can re-ask. */
export function resetEdgeFunctionStatus() {
  askPromise = null
  mealPromise = null
}

export function useEdgeFunctionStatus() {
  const [ask, setAsk] = useState('checking')
  const [meal, setMeal] = useState('checking')

  useEffect(() => {
    let cancelled = false
    probeAsk().then((s) => {
      if (!cancelled) setAsk(s)
    })
    probeMeal().then((s) => {
      if (!cancelled) setMeal(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return { ask, meal }
}
