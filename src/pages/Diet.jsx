import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { hasColumn } from '../lib/schema'
import { localDay } from '../lib/diet/totals'
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh'
import { GoalsSkeleton } from '../components/ui/PageSkeleton'
import ErrorState from '../components/ui/ErrorState'
import { loadLibrary, loadDay } from '../components/diet/api'
import DietToday from '../components/diet/DietToday'
import DailySheet from '../components/diet/DailySheet'
import WeightTab from '../components/diet/WeightTab'
import LibraryTab from '../components/diet/LibraryTab'
import DietSettingsForm from '../components/diet/DietSettingsForm'
import AddFoodSheet from '../components/diet/AddFoodSheet'

const TABS = [
  ['today', 'Today'],
  ['sheet', 'Sheet'],
  ['weight', 'Weight'],
  ['library', 'Library'],
  ['settings', 'Settings'],
]

/**
 * Diet: the seventh module, replacing Meals (docs/diet-module.md).
 *
 * One page, five tabs, the tab in the URL (?tab=sheet) so the Daily HQ
 * card and a bookmark can land on the right one. ?add=1 opens the add-food
 * sheet straight away (the PWA shortcut); ?snap=1, the old Meals
 * shortcut's parameter, does the same until the camera returns in Phase 3.
 *
 * The library (settings, foods, recipes, saved meals) and today's meals
 * load once and refresh over realtime when another device logs, the way
 * Meals did (useRealtimeRefresh).
 *
 * Added for the Diet module, Phase 1.
 */
export default function Diet() {
  const available = hasColumn('meal_logs.eaten_on')
  const [params, setParams] = useSearchParams()
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'today'
  const [lib, setLib] = useState(null)
  const [todayLogs, setTodayLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(false)
  // Phase 3: what the add sheet opens on: a new photo, or an 'auto' meal to check.
  const [sheetStart, setSheetStart] = useState({ initialFile: null, checkMeal: null })
  const [sheetDay, setSheetDay] = useState(() => localDay(new Date()))
  const [sheetKey, setSheetKey] = useState(0)
  const today = localDay(new Date())

  const load = useCallback(async () => {
    if (!available) {
      setLoading(false)
      return
    }
    try {
      const [l, logs] = await Promise.all([loadLibrary(), loadDay(today)])
      setLib(l)
      setTodayLogs(logs)
      setError(null)
    } catch (err) {
      setError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [available, today])

  useEffect(() => {
    load()
  }, [load])
  useRealtimeRefresh(['meal_logs', 'meal_items', 'saved_meals', 'diet_settings'], load, { channelPrefix: 'diet', enabled: available })

  useEffect(() => {
    if (params.get('add') === '1' || params.get('snap') === '1') {
      setAdding(true)
      params.delete('add')
      params.delete('snap')
      setParams(params, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const goTab = (key) => {
    const next = new URLSearchParams(params)
    if (key === 'today') next.delete('tab')
    else next.set('tab', key)
    setParams(next, { replace: true })
  }

  const changed = () => {
    load()
    setSheetKey((k) => k + 1)
  }

  if (!available) {
    return (
      <div className="space-y-6">
        <Header />
        <div className="rounded-3xl bg-orange-500/10 border border-orange-500/20 p-6 text-sm text-orange-200 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/048_diet.sql</code>, then <code className="font-mono">049_diet_seed.sql</code> and{' '}
          <code className="font-mono">050_diet_backfill.sql</code>, in the Supabase SQL editor, then reload. They create the Diet tables, add the starting foods and
          copy your old Meals log across.
        </div>
      </div>
    )
  }

  if (loading) return <GoalsSkeleton />
  if (error) return <ErrorState message={error} onRetry={load} />

  return (
    <div className="space-y-6">
      <Header />
      <div className="flex gap-1 p-1 rounded-2xl bg-card border border-white/5 overflow-x-auto scrollbar-none" role="tablist" aria-label="Diet">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => goTab(key)}
            className={`flex-1 shrink-0 px-3 min-h-[44px] rounded-xl text-xs font-bold ${tab === key ? 'bg-accent text-black' : 'text-muted hover:text-white'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'today' && (
        <DietToday
          lib={lib}
          logs={todayLogs}
          onChanged={changed}
          onAdd={() => {
            setSheetStart({ initialFile: null, checkMeal: null })
            setAdding(true)
          }}
          onPhoto={(file) => {
            setSheetStart({ initialFile: file, checkMeal: null })
            setAdding(true)
          }}
          onCheck={(meal) => {
            setSheetStart({ initialFile: null, checkMeal: meal })
            setAdding(true)
          }}
          onOpenSettings={() => goTab('settings')}
        />
      )}
      {tab === 'sheet' && <DailySheet key={sheetKey} day={sheetDay} onDayChange={setSheetDay} onChanged={load} />}
      {tab === 'weight' && <WeightTab onChanged={load} />}
      {tab === 'library' && <LibraryTab lib={lib} onChanged={load} />}
      {tab === 'settings' && <DietSettingsForm key={lib.settings?.updated_at ?? 'new'} settings={lib.settings} onSaved={load} />}

      <AddFoodSheet
        isOpen={adding}
        onClose={() => {
          setAdding(false)
          setSheetStart({ initialFile: null, checkMeal: null })
        }}
        lib={lib}
        todayLogs={todayLogs}
        onLogged={changed}
        initialFile={sheetStart.initialFile}
        checkMeal={sheetStart.checkMeal}
      />
    </div>
  )
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl md:text-3xl font-bold text-white">Diet 🥗</h1>
      <p className="text-muted text-sm mt-1">What you ate today against your targets. One tap for the usual meals.</p>
    </div>
  )
}
