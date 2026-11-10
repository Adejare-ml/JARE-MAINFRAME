import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { confirmBuzz } from '../../lib/haptics'
import { buildSparkline } from '../../lib/sparkline'
import { formatDate } from '../../lib/formatters'
import { localDay, addDays } from '../../lib/diet/totals'
import { toNumber, round1 } from '../../lib/diet/nutrition'
import { SkeletonRows } from '../ui/Skeleton'
import ErrorState from '../ui/ErrorState'

/** Weigh-ins shown on the trend. Weekly for a year is 52; a few spare. */
const HISTORY = 60

/**
 * Weight: the weekly weigh-in and its trend.
 *
 * One weigh-in a day (a unique index in migration 048): logging twice on
 * the same day replaces the first, which is what a re-weigh means. The
 * trend reuses the sparkline maths the Budget page's net-worth line uses
 * (src/lib/sparkline.js); NetWorthSparkline itself formats naira, so it is
 * not reused as a component.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
export default function WeightTab({ onChanged }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [kg, setKg] = useState('')
  const [day, setDay] = useState(() => localDay(new Date()))
  const [saving, setSaving] = useState(false)
  const today = localDay(new Date())

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.from('weight_logs').select('id, logged_at, weight_kg').order('logged_at', { ascending: false }).limit(HISTORY)
    if (err) setError(err.message)
    else {
      setError(null)
      setEntries(data || [])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const save = async (e) => {
    e.preventDefault()
    const w = toNumber(kg)
    if (w == null || w < 30 || w > 400) {
      toast.error('A weight between 30 and 400 kg')
      return
    }
    setSaving(true)
    const { error: err } = await supabase.from('weight_logs').upsert({ logged_at: day, weight_kg: round1(w) }, { onConflict: 'user_id,logged_at' })
    setSaving(false)
    if (err) {
      toast.error('Not saved: ' + err.message)
      return
    }
    confirmBuzz()
    toast.success(`${round1(w)} kg logged ✓`)
    setKg('')
    load()
    onChanged?.()
  }

  const remove = async (id) => {
    const { error: err } = await supabase.from('weight_logs').delete().eq('id', id)
    if (err) toast.error('Could not delete: ' + err.message)
    load()
  }

  const ascending = [...entries].reverse()
  const latest = entries[0]
  const first = ascending[0]
  const daysSince = latest ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${latest.logged_at}T00:00:00Z`)) / 86400000) : null
  const weekAgo = entries.find((e) => e.logged_at <= addDays(latest?.logged_at ?? today, -6))
  const line = buildSparkline(ascending.map((e) => ({ date: e.logged_at, total: Number(e.weight_kg) })), { width: 320, height: 96 })

  return (
    <div className="space-y-6">
      <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4" aria-label="Log a weigh-in">
        <div>
          <p className="text-xs font-semibold text-muted uppercase tracking-wider">Weigh-in</p>
          <p className="text-[11px] text-muted mt-1">
            {latest
              ? daysSince >= 7
                ? `Last weigh-in ${daysSince} days ago. Time for this week's.`
                : `Last weigh-in ${daysSince === 0 ? 'today' : `${daysSince} day${daysSince === 1 ? '' : 's'} ago`}. Next one in ${7 - daysSince} day${7 - daysSince === 1 ? '' : 's'}.`
              : 'Once a week, same morning, before breakfast.'}
          </p>
        </div>
        <form onSubmit={save} className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <label htmlFor="weight-kg" className="sr-only">
            Weight in kg
          </label>
          <input
            id="weight-kg"
            type="number"
            inputMode="decimal"
            step="0.1"
            value={kg}
            onChange={(e) => setKg(e.target.value)}
            placeholder="kg"
            className="min-w-0 px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[48px]"
          />
          <label htmlFor="weight-day" className="sr-only">
            Date
          </label>
          <input id="weight-day" type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} className="min-w-0 px-3 py-3 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[48px]" />
          <button type="submit" disabled={saving} className="px-5 bg-accent text-black rounded-xl font-bold text-sm min-h-[48px] disabled:opacity-50">
            {saving ? '…' : 'Log'}
          </button>
        </form>
      </section>

      <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-4" aria-label="Trend">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Trend</h2>
        {loading ? (
          <SkeletonRows count={3} />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : entries.length < 2 ? (
          <p className="text-xs text-muted-dim">{entries.length === 0 ? 'No weigh-ins yet.' : 'One weigh-in so far. The line appears with the second.'}</p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="Now" value={`${round1(latest.weight_kg)} kg`} />
              <Stat label="7 days" value={weekAgo ? signed(round1(latest.weight_kg - weekAgo.weight_kg)) : '–'} />
              <Stat label="Since start" value={signed(round1(latest.weight_kg - first.weight_kg))} />
            </div>
            <svg viewBox="0 0 320 96" className="w-full h-24" preserveAspectRatio="none" role="img" aria-label={`Weight from ${round1(first.weight_kg)} kg to ${round1(latest.weight_kg)} kg`}>
              <path d={line.path} fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinejoin="round" />
              {line.coords.map((c) => (
                <circle key={c.date} cx={c.x} cy={c.y} r="2.5" fill="var(--color-accent)" />
              ))}
            </svg>
            <div className="flex justify-between text-[10px] text-muted-dim">
              <span>
                {formatDate(first.logged_at)} · {round1(line.min)}–{round1(line.max)} kg
              </span>
              <span>{formatDate(latest.logged_at)}</span>
            </div>
          </>
        )}
        {entries.length > 0 && (
          <ul className="divide-y divide-white/5">
            {entries.slice(0, 12).map((e) => (
              <li key={e.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-muted">{formatDate(e.logged_at)}</span>
                <span className="flex items-center gap-2">
                  <span className="text-white font-bold tabular-nums">{round1(e.weight_kg)} kg</span>
                  <button type="button" onClick={() => remove(e.id)} className="min-w-[44px] min-h-[44px] rounded-full text-muted hover:text-red-300" aria-label={`Delete weigh-in of ${formatDate(e.logged_at)}`}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function signed(n) {
  return `${n > 0 ? '+' : ''}${n} kg`
}

function Stat({ label, value }) {
  return (
    <div className="rounded-2xl bg-background/50 border border-white/5 p-3">
      <p className="text-[10px] text-muted uppercase tracking-wider">{label}</p>
      <p className="text-sm font-extrabold text-white tabular-nums">{value}</p>
    </div>
  )
}
