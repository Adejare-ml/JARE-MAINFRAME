import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { hasColumn } from '../../lib/schema'
import { toDateOnly } from '../../lib/queries'
import { dayTotals, targetProgress, parseCalorieTarget, CALORIE_TARGET_KEY, summarizeItems } from '../../lib/meals'
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh'
import ProgressRing from '../ui/ProgressRing'
import MealCapture from '../meals/MealCapture'

/**
 * Today's food on Daily HQ, with the camera one tap away.
 *
 * The primary control is a <label> around a file input with
 * capture=environment, so the first tap opens the phone's camera and the
 * capture sheet appears already working on the photo. Hosting the sheet
 * here, rather than linking to the Meals page first, is what makes it one
 * tap instead of four.
 *
 * Renders a one-line notice when migration 042 has not run; nothing when
 * it has and the owner has never used it, except the button.
 */
export default function FoodToday() {
  const available = hasColumn('meals.items')
  const [meals, setMeals] = useState([])
  const [target, setTarget] = useState(null)
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState(null)
  const today = toDateOnly(new Date())

  const load = useCallback(async () => {
    if (!available) return
    const [mealsRes, settingRes] = await Promise.all([
      supabase.from('meals').select('id, items, calories, meal_type, created_at').eq('eaten_on', today).order('created_at', { ascending: false }),
      supabase.from('user_settings').select('value').eq('key', CALORIE_TARGET_KEY).maybeSingle(),
    ])
    if (!mealsRes.error) setMeals(mealsRes.data || [])
    setTarget(parseCalorieTarget(settingRes.data?.value))
  }, [available, today])

  useEffect(() => {
    load()
  }, [load])
  useRealtimeRefresh(['meals'], load, { channelPrefix: 'foodtoday', enabled: available })

  if (!available) {
    return (
      <section className="bg-card rounded-3xl p-6 border border-white/5">
        <p className="text-xs font-semibold text-muted uppercase tracking-wider mb-1">Food today</p>
        <p className="text-xs text-orange-300 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/042_meals.sql</code> to log meals from a photo.
        </p>
      </section>
    )
  }

  const totals = dayTotals(meals)
  const progress = targetProgress(totals.calories, target)
  const last = meals[0]

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5">
      <div className="flex items-center gap-4">
        <ProgressRing
          value={progress.ratio ?? 0}
          size={64}
          strokeWidth={6}
          color={progress.status === 'over' ? '#f87171' : progress.status === 'near' ? '#fdba74' : 'var(--color-accent)'}
        >
          <span className="text-lg" aria-hidden="true">🍽️</span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-muted uppercase tracking-wider">Food today</p>
          <p className="text-xl font-extrabold text-white tabular-nums">
            {totals.calories.toLocaleString()} <span className="text-sm font-bold text-muted">kcal</span>
            {progress.remaining != null && (
              <span className={`text-sm font-bold ml-2 ${progress.over ? 'text-red-400' : 'text-muted'}`}>
                {progress.over ? `${Math.abs(progress.remaining).toLocaleString()} over` : `${progress.remaining.toLocaleString()} left`}
              </span>
            )}
          </p>
          <p className="text-[11px] text-muted truncate">
            {last ? `${totals.count} meal${totals.count === 1 ? '' : 's'} · last: ${summarizeItems(last.items, 48)}` : target ? `Target ${target.toLocaleString()} kcal. Nothing logged yet.` : 'Nothing logged yet.'}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2 mt-4">
        <label className="flex items-center justify-center gap-2 bg-accent text-black font-extrabold text-sm rounded-xl min-h-[48px] cursor-pointer hover:bg-accent/90">
          <span aria-hidden="true">📷</span> Snap a meal
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              setFile(f)
              setOpen(true)
            }}
          />
        </label>
        <Link to="/meals" className="flex items-center justify-center px-4 rounded-xl bg-white/5 border border-white/5 text-white text-sm font-bold min-h-[48px] hover:bg-white/10">
          Meals →
        </Link>
      </div>
      <MealCapture
        isOpen={open}
        initialFile={file}
        onClose={() => {
          setOpen(false)
          setFile(null)
        }}
        onLogged={load}
      />
    </section>
  )
}
