import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { hasColumn } from '../../lib/schema'
import { localDay, dayTotals, remaining } from '../../lib/diet/totals'
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh'
import { loadLibrary, loadDay } from '../diet/api'
import ProgressRing from '../ui/ProgressRing'
import AddFoodSheet from '../diet/AddFoodSheet'

/**
 * Calories and protein left today, on Daily HQ (the Diet module, Phase 1).
 *
 * Takes the place of FoodToday (042), which read the old meals table. Like
 * FoodToday it hosts its own sheet, so logging takes one tap from here
 * rather than a trip to the Diet page first. The camera button FoodToday
 * had is not here: its photo reader, the analyze-meal edge function, is
 * marked unverified in its own header and imports a file that moved in
 * #180, so it cannot deploy as it stands. Photo logging returns with the
 * three-model analysis in Phase 3 (docs/diet-module.md).
 *
 * Renders a one-line notice when migration 048 has not run.
 */
export default function DietCard() {
  const available = hasColumn('meal_logs.eaten_on')
  const [lib, setLib] = useState(null)
  const [logs, setLogs] = useState([])
  const [open, setOpen] = useState(false)
  // Phase 3: the camera returns to the card: a photo opens the sheet on it.
  const [file, setFile] = useState(null)
  const today = localDay(new Date())

  const load = useCallback(async () => {
    if (!available) return
    try {
      const [l, d] = await Promise.all([loadLibrary(), loadDay(today)])
      setLib(l)
      setLogs(d)
    } catch (err) {
      console.warn('Diet card could not load:', err.message)
    }
  }, [available, today])

  useEffect(() => {
    load()
  }, [load])
  useRealtimeRefresh(['meal_logs', 'meal_items', 'diet_settings'], load, { channelPrefix: 'dietcard', enabled: available })

  if (!available) {
    return (
      <section className="bg-card rounded-3xl p-6 border border-white/5">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Diet today</p>
        <p className="text-xs text-orange-300 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/048_diet.sql</code> (then 049 and 050) to track calories and protein.
        </p>
      </section>
    )
  }

  const totals = dayTotals(logs)
  const left = remaining(totals, lib?.settings)
  const ringColor = left.over ? '#f87171' : left.kcal_ratio != null && left.kcal_ratio >= 0.85 ? '#fdba74' : 'var(--color-accent)'

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5" aria-label="Diet today">
      <div className="flex items-center gap-4">
        <ProgressRing value={left.kcal_ratio ?? 0} size={64} strokeWidth={6} color={ringColor}>
          <span className="text-lg" aria-hidden="true">
            🥗
          </span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider">Diet today</p>
          {left.kcal_left != null ? (
            <p className={`text-xl font-extrabold tabular-nums ${left.over ? 'text-red-400' : 'text-white'}`}>
              {Math.abs(left.kcal_left).toLocaleString()} <span className="text-sm font-bold text-muted">kcal {left.over ? 'over' : 'left'}</span>
            </p>
          ) : (
            <p className="text-xl font-extrabold text-white tabular-nums">
              {totals.kcal.toLocaleString()} <span className="text-sm font-bold text-muted">kcal</span>
            </p>
          )}
          <p className="text-[11px] text-muted truncate">
            {left.protein_left != null
              ? left.protein_met
                ? `Protein target met (${totals.protein_g} g)`
                : `${left.protein_left} g protein to go`
              : `${totals.protein_g} g protein`}
            {' · '}
            {totals.count} meal{totals.count === 1 ? '' : 's'}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 mt-4">
        <label className={`flex items-center justify-center gap-2 bg-accent text-black font-extrabold text-sm rounded-xl min-h-[48px] cursor-pointer hover:bg-accent/90 ${lib ? '' : 'opacity-60 pointer-events-none'}`}>
          <span aria-hidden="true">📷</span> Snap
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            disabled={!lib}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              setFile(f)
              setOpen(true)
            }}
          />
        </label>
        <button
          type="button"
          onClick={() => {
            setFile(null)
            setOpen(true)
          }}
          disabled={!lib}
          className="flex items-center justify-center gap-2 bg-white/10 border border-white/10 text-white font-extrabold text-sm rounded-xl min-h-[48px] hover:bg-white/15 disabled:opacity-60"
        >
          <span aria-hidden="true">＋</span> Log food
        </button>
        <Link to="/diet" className="flex items-center justify-center px-4 rounded-xl bg-white/5 border border-white/5 text-white text-sm font-bold min-h-[48px] hover:bg-white/10">
          Diet →
        </Link>
      </div>
      {lib && (
        <AddFoodSheet
          isOpen={open}
          onClose={() => {
            setOpen(false)
            setFile(null)
          }}
          lib={lib}
          todayLogs={logs}
          onLogged={load}
          initialFile={file}
        />
      )}
    </section>
  )
}
