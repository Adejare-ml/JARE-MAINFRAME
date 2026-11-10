import { useState } from 'react'
import { askWhatNext } from './api'

/**
 * "What should I eat next?" (Diet module, Phase 4). Sends what is left of
 * today, the time, the last 7 days and the pantry to the coach (diet-coach,
 * prompts/coach.md) and shows two or three options, pantry food first.
 * The options have already been checked (src/lib/diet/coach.js): nothing
 * with a food the owner avoids, nothing that skips a meal.
 */
export default function WhatNext() {
  const [state, setState] = useState({ busy: false, result: null, error: null })

  const ask = async () => {
    setState({ busy: true, result: null, error: null })
    const res = await askWhatNext()
    setState({ busy: false, result: res.ok ? res : null, error: res.ok ? null : res.reason })
  }

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3" aria-label="What to eat next">
      <button type="button" onClick={ask} disabled={state.busy} className="w-full min-h-[48px] rounded-xl bg-white/5 border border-white/10 text-white text-sm font-bold disabled:opacity-60">
        {state.busy ? 'Asking the coach…' : '🧭 What should I eat next?'}
      </button>
      {state.error && (
        <p className="text-[11px] text-orange-300" role="alert">
          {state.error}
        </p>
      )}
      {state.result && (
        <div className="space-y-2" aria-live="polite">
          {state.result.reason && <p className="text-sm text-white leading-relaxed">{state.result.reason}</p>}
          <ul className="space-y-2">
            {state.result.next_options.map((o, i) => (
              <li key={i} className="rounded-2xl border border-white/10 bg-background/50 p-3">
                <p className="text-sm font-bold text-white">
                  {o.meal}
                  {o.from_pantry && <span className="ml-2 text-[10px] font-extrabold uppercase tracking-wider text-accent">at home</span>}
                </p>
                <p className="text-[11px] text-muted tabular-nums">
                  {o.kcal.toLocaleString()} kcal · {o.protein_g} g protein{o.why ? ` · ${o.why}` : ''}
                </p>
              </li>
            ))}
          </ul>
          {state.result.next_options.length === 0 && <p className="text-[11px] text-muted">No suggestion passed the checks. Try again in a moment.</p>}
          {state.result.flag && <p className="text-[11px] text-orange-300">{state.result.flag}</p>}
        </div>
      )}
    </section>
  )
}
