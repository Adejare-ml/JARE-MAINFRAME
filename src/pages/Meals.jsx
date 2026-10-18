import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { hasColumn } from '../lib/schema'
import { toDateOnly } from '../lib/queries'
import { formatTime } from '../lib/formatters'
import { toast } from '../lib/toast'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import {
  dayTotals,
  targetProgress,
  parseCalorieTarget,
  CALORIE_TARGET_KEY,
  summarizeItems,
  daySeries,
  repeatCandidates,
  itemsForStorage,
  mealTypeFor,
  MEAL_TYPE_ICONS,
} from '../lib/meals'
import ProgressRing from '../components/ui/ProgressRing'
import EmptyState from '../components/ui/EmptyState'
import ErrorState from '../components/ui/ErrorState'
import { GoalsSkeleton } from '../components/ui/PageSkeleton'
import MealCapture from '../components/meals/MealCapture'

/** Days the page reads at once: today's list and the week strip, one query. */
const WINDOW_DAYS = 7

/**
 * The day's eating against a target, and every way to add to it.
 *
 * One query for seven days (the table is small: a few rows a day), the
 * realtime channel to refresh when another device logs, and the capture
 * sheet for new meals. "Again" logs a recent meal in one tap through the
 * same log_meal function, so the server sums it and the row carries
 * source 'repeat'.
 */
export default function Meals() {
  const available = hasColumn('meals.items')
  const [params, setParams] = useSearchParams()
  const [meals, setMeals] = useState([])
  const [target, setTarget] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sheet, setSheet] = useState(null) // null | 'photo' | 'text' | 'pick'
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [repeating, setRepeating] = useState(null)
  const today = toDateOnly(new Date())

  const load = useCallback(async () => {
    if (!available) {
      setLoading(false)
      return
    }
    const since = new Date()
    since.setDate(since.getDate() - (WINDOW_DAYS - 1))
    const [mealsRes, settingRes] = await Promise.all([
      supabase
        .from('meals')
        .select('id, client_id, eaten_on, eaten_at, meal_type, items, calories, source, thumbnail, created_at')
        .gte('eaten_on', toDateOnly(since))
        .order('eaten_on', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase.from('user_settings').select('value').eq('key', CALORIE_TARGET_KEY).maybeSingle(),
    ])
    if (mealsRes.error) {
      setError(mealsRes.error.message)
    } else {
      setError(null)
      setMeals(mealsRes.data || [])
    }
    setTarget(parseCalorieTarget(settingRes.data?.value))
    setLoading(false)
  }, [available])

  useEffect(() => {
    load()
  }, [load])
  useRealtimeRefresh(['meals'], load, { channelPrefix: 'meals', enabled: available })

  // /meals?snap=1 (the manifest shortcut, a notification tap) opens the sheet.
  useEffect(() => {
    if (params.get('snap') === '1') {
      setSheet('photo')
      params.delete('snap')
      setParams(params, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const todays = meals.filter((m) => m.eaten_on === today)
  const totals = dayTotals(todays)
  const progress = targetProgress(totals.calories, target)
  const series = daySeries(meals, today, WINDOW_DAYS)
  const maxDay = Math.max(target || 0, ...series.map((d) => d.calories), 1)
  const again = repeatCandidates(meals, 5)

  const repeat = async (pick) => {
    setRepeating(pick.label)
    try {
      const now = new Date()
      const { data, error: rpcError } = await supabase.rpc('log_meal', {
        p_client_id: crypto.randomUUID(),
        p_items: itemsForStorage(pick.items),
        p_eaten_on: today,
        p_eaten_at: now.toTimeString().split(' ')[0],
        p_meal_type: mealTypeFor(now.getHours()),
        p_source: 'repeat',
        p_thumbnail: pick.meal.thumbnail || null,
      })
      if (rpcError) throw rpcError
      toast.success(`${Number(data?.calories ?? pick.calories).toLocaleString()} kcal logged again ✓`, {
        action: data?.id ? { label: 'Undo', onClick: () => remove(data.id, true) } : null,
      })
      load()
    } catch (err) {
      toast.error('Not logged: ' + (err.message || 'check connection'))
    } finally {
      setRepeating(null)
    }
  }

  // Two taps to delete, and the question withdraws itself after a moment.
  const askDelete = (id) => {
    setConfirmDelete(id)
    setTimeout(() => setConfirmDelete((c) => (c === id ? null : c)), 4000)
  }

  const remove = async (id, silent = false) => {
    const { error: delError } = await supabase.from('meals').delete().eq('id', id)
    setConfirmDelete(null)
    if (delError) {
      toast.error('Could not delete: ' + delError.message)
      return
    }
    if (!silent) toast.success('Meal removed')
    load()
  }

  if (!available) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-3xl bg-orange-500/10 border border-orange-500/20 p-6 text-sm text-orange-200 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/042_meals.sql</code> in the Supabase SQL editor, then reload. It creates the
          meals table and the function that logs into it. The analyze-meal edge function (see README) reads the photos.
        </div>
      </div>
    )
  }

  if (loading) return <GoalsSkeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="space-y-6">
      <Header />

      {/* Today */}
      <section className="bg-card rounded-3xl p-6 border border-white/10 shadow-xl">
        <div className="flex items-center gap-5">
          <ProgressRing
            value={progress.ratio ?? 0}
            size={104}
            strokeWidth={9}
            color={progress.status === 'over' ? '#f87171' : progress.status === 'near' ? '#fdba74' : 'var(--color-accent)'}
          >
            <div className="text-center">
              <p className="text-xl font-extrabold text-white tabular-nums leading-none">{totals.calories.toLocaleString()}</p>
              <p className="text-[10px] text-muted mt-1">kcal</p>
            </div>
          </ProgressRing>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-muted uppercase tracking-wider">Today</p>
            {target ? (
              <p className={`text-2xl font-extrabold tabular-nums ${progress.over ? 'text-red-400' : 'text-white'}`}>
                {progress.over ? `${Math.abs(progress.remaining).toLocaleString()} over` : `${progress.remaining.toLocaleString()} left`}
              </p>
            ) : (
              <p className="text-sm text-white">
                No daily target yet.{' '}
                <Link to="/settings" className="text-accent font-bold hover:underline">
                  Set one →
                </Link>
              </p>
            )}
            <p className="text-[11px] text-muted mt-1">
              {target ? `of ${target.toLocaleString()} kcal · ` : ''}
              {totals.count} meal{totals.count === 1 ? '' : 's'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-5">
          <button type="button" onClick={() => setSheet('photo')} className="col-span-3 sm:col-span-1 flex items-center justify-center gap-2 bg-accent text-black font-extrabold text-sm rounded-xl min-h-[52px] hover:bg-accent/90">
            <span aria-hidden="true">📷</span> Snap a meal
          </button>
          <button type="button" onClick={() => setSheet('text')} className="flex items-center justify-center gap-2 bg-white/5 border border-white/5 text-white font-bold text-sm rounded-xl min-h-[48px] hover:bg-white/10">
            ✍️ Describe
          </button>
          <button type="button" onClick={() => setSheet('pick')} className="flex items-center justify-center gap-2 bg-white/5 border border-white/5 text-white font-bold text-sm rounded-xl min-h-[48px] hover:bg-white/10">
            📋 Pick
          </button>
        </div>

        {again.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-semibold text-muted uppercase tracking-wider mb-2">Again</p>
            <div className="flex gap-2 overflow-x-auto scrollbar-none pb-1">
              {again.map((pick) => (
                <button
                  key={pick.meal.id}
                  type="button"
                  onClick={() => repeat(pick)}
                  disabled={repeating != null}
                  className="shrink-0 flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full bg-white/5 border border-white/10 hover:border-accent/50 min-h-[48px] disabled:opacity-60 max-w-[260px]"
                  aria-label={`Log again: ${pick.label}, ${pick.calories} kcal`}
                >
                  {pick.meal.thumbnail ? (
                    <img src={pick.meal.thumbnail} alt="" className="w-9 h-9 rounded-full object-cover bg-black" />
                  ) : (
                    <span className="w-9 h-9 rounded-full bg-background flex items-center justify-center text-base" aria-hidden="true">
                      {MEAL_TYPE_ICONS[pick.meal.meal_type] || '🍽️'}
                    </span>
                  )}
                  <span className="text-left min-w-0">
                    <span className="block text-xs font-bold text-white truncate">{repeating === pick.label ? 'Logging…' : pick.label}</span>
                    <span className="block text-[10px] text-muted">{pick.calories} kcal</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* The week */}
      <section className="bg-card rounded-3xl p-6 border border-white/5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Last 7 days</h2>
          {target && <span className="text-[11px] text-muted-dim">line = {target.toLocaleString()} kcal</span>}
        </div>
        <div className="relative h-28">
          {target && (
            <div className="absolute left-0 right-0 border-t border-dashed border-white/20" style={{ bottom: `${Math.min(100, (target / maxDay) * 100)}%` }} aria-hidden="true" />
          )}
          <ul className="absolute inset-0 grid grid-cols-7 gap-2 items-end" aria-label="Calories per day">
            {series.map((d) => {
              const over = target && d.calories > target
              const isToday = d.date === today
              const label = new Date(`${d.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' })
              return (
                <li key={d.date} className="flex flex-col items-center justify-end h-full gap-1" aria-label={`${label}: ${d.calories} kcal`}>
                  <span className="text-[10px] text-muted-dim tabular-nums">{d.calories ? d.calories.toLocaleString() : ''}</span>
                  <div
                    className={`w-full rounded-t-lg ${over ? 'bg-red-400/70' : isToday ? 'bg-accent' : 'bg-accent/40'}`}
                    style={{ height: `${Math.max(d.calories ? 4 : 1, (d.calories / maxDay) * 80)}%` }}
                  />
                  <span className={`text-[10px] ${isToday ? 'text-white font-bold' : 'text-muted'}`}>{label}</span>
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      {/* Today's meals */}
      <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Today's meals</h2>
        {todays.length === 0 ? (
          <EmptyState icon="🍽️" title="Nothing logged today" message="Snap the plate before you start. It takes one tap and about ten seconds." actionLabel="Snap a meal" onAction={() => setSheet('photo')} />
        ) : (
          <ul className="space-y-2">
            {todays.map((m) => (
              <li key={m.id} className="flex items-center gap-3 p-3 rounded-2xl bg-background/40 border border-white/5">
                {m.thumbnail ? (
                  <img src={m.thumbnail} alt="" className="w-12 h-12 rounded-xl object-cover bg-black shrink-0" />
                ) : (
                  <span className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-xl shrink-0" aria-hidden="true">
                    {MEAL_TYPE_ICONS[m.meal_type] || '🍽️'}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">{summarizeItems(m.items, 60) || m.meal_type}</p>
                  <p className="text-[11px] text-muted capitalize">
                    {m.meal_type}
                    {m.eaten_at ? ` · ${formatTime(m.eaten_at)}` : ''}
                    {m.source === 'repeat' ? ' · again' : m.source === 'text' ? ' · described' : m.source === 'manual' ? ' · picked' : ''}
                  </p>
                </div>
                <span className="text-sm font-bold text-white tabular-nums shrink-0">{Number(m.calories).toLocaleString()} kcal</span>
                {confirmDelete === m.id ? (
                  <button type="button" onClick={() => remove(m.id)} className="shrink-0 px-3 h-10 rounded-xl bg-red-500/20 text-red-300 text-xs font-bold min-h-[48px]">
                    Delete?
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => askDelete(m.id)}
                    className="shrink-0 w-10 h-10 rounded-full bg-white/5 hover:bg-red-500/20 text-muted hover:text-red-300 flex items-center justify-center text-sm min-h-[48px] min-w-[48px]"
                    aria-label={`Delete ${summarizeItems(m.items, 40) || 'this meal'}`}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <MealCapture isOpen={sheet != null} initialMode={sheet || 'photo'} onClose={() => setSheet(null)} onLogged={load} />
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold text-white">Meals 🍽️</h1>
      <p className="text-muted text-sm mt-1">Photograph the plate; the model names the dishes and counts the calories. You fix the portions.</p>
    </div>
  )
}
