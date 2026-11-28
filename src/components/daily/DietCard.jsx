import { useCallback, useEffect, useState } from 'react'
import { hasColumn } from '../../lib/schema'
import { localDay, dayTotals, remaining } from '../../lib/diet/totals'
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh'
import { loadLibrary, loadDay } from '../diet/api'
import ProgressRing from '../ui/ProgressRing'
import Panel from '../ui/Panel'
import Readout from '../ui/Readout'
import Button, { buttonClasses } from '../ui/Button'
import Icon from '../ui/Icon'
import AddFoodSheet from '../diet/AddFoodSheet'

/**
 * Calories and protein left today, on Daily HQ (the Diet module, Phase 1).
 *
 * Took the place of FoodToday (042, since deleted), which read the old
 * meals table. It hosts its own sheet, so logging takes one tap from here
 * rather than a trip to the Diet page first; Snap opens the same sheet on a
 * photo (Phase 3, docs/diet-module.md).
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
      <Panel label="Food today" tone="warn">
        <p className="text-body-sm text-muted">
          Run <code className="type-data text-foreground">supabase/migrations/048_diet.sql</code> (then 049 and 050) to track calories and protein.
        </p>
      </Panel>
    )
  }

  const totals = dayTotals(logs)
  const left = remaining(totals, lib?.settings)
  const near = !left.over && left.kcal_ratio != null && left.kcal_ratio >= 0.85
  const ringColor = left.over ? 'var(--color-danger)' : near ? 'var(--color-warn)' : 'var(--color-accent)'

  return (
    <Panel
      label="Food today"
      meta={`${totals.count} meal${totals.count === 1 ? '' : 's'}`}
      action={<Button size="sm" variant="ghost" to="/diet">Diet</Button>}
    >
      <div className="flex items-center gap-3">
        <ProgressRing value={left.kcal_ratio ?? 0} size={52} strokeWidth={5} color={ringColor} />
        <div className="min-w-0 flex-1">
          {left.kcal_left != null ? (
            <Readout
              kind="number"
              value={Math.abs(left.kcal_left)}
              unit={left.over ? 'kcal over' : 'kcal left'}
              tone={left.over ? 'danger' : 'default'}
            />
          ) : (
            <Readout kind="number" value={totals.kcal} unit="kcal" />
          )}
          <p className="text-body-sm text-muted truncate">
            {left.protein_left != null
              ? left.protein_met
                ? `Protein target met (${totals.protein_g} g)`
                : `${left.protein_left} g protein to go`
              : `${totals.protein_g} g protein`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 mt-3">
        <label className={`${buttonClasses({ variant: 'primary', full: true })} cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${lib ? '' : 'opacity-50 pointer-events-none'}`}>
          <Icon name="camera" size={18} /> Snap
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
        <Button
          variant="secondary"
          icon="plus"
          full
          onClick={() => {
            setFile(null)
            setOpen(true)
          }}
          disabled={!lib}
        >
          Log food
        </Button>
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
    </Panel>
  )
}
