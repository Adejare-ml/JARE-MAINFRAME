import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { sheetRows, sheetTotals, sheetCsv, sheetXlsx, sheetFilename, SHEET_COLUMNS } from '../../lib/diet/sheet'
import { sevenDayAverage, localDay, addDays } from '../../lib/diet/totals'
import { toNumber, round1 } from '../../lib/diet/nutrition'
import { formatDate } from '../../lib/formatters'
import { loadDay, loadWeek } from './api'
import { SkeletonRows } from '../ui/Skeleton'
import ErrorState from '../ui/ErrorState'

/**
 * The Daily Sheet: every item of a day in a table, the day total, the
 * 7-day average, and the same table as CSV or XLSX.
 *
 * The first <table> in this app (every other list is cards). On a phone it
 * scrolls sideways inside its card with the item column pinned, rather
 * than squeezing eight columns into 360 pixels.
 *
 * Grams are editable in place. An item backed by a food or a recipe is
 * re-priced by the database (migration 048, diet_item_figures); a custom
 * item has no food behind it, so its figures are scaled here by the change
 * in grams. Either way the meal is marked 'edited' and re-summed by the
 * database, and the sheet reloads what was stored.
 *
 * The XLSX writer (write-excel-file, its universal build) is imported only
 * when the button is tapped, so it is a separate chunk and costs nothing
 * on an ordinary visit.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */
export default function DailySheet({ day, onDayChange, onChanged }) {
  const [logs, setLogs] = useState([])
  const [week, setWeek] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null)
  const [exporting, setExporting] = useState(null)
  const today = localDay(new Date())

  const load = useCallback(async () => {
    try {
      const [d, w] = await Promise.all([loadDay(day), loadWeek(day)])
      setLogs(d)
      setWeek(w)
      setError(null)
    } catch (err) {
      setError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [day])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  const rows = sheetRows(logs)
  const totals = sheetTotals(rows)
  const average = sevenDayAverage(week, day)

  const download = (blob, name) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const exportCsv = () => {
    download(new Blob([sheetCsv({ rows, average })], { type: 'text/csv;charset=utf-8' }), sheetFilename(day, 'csv'))
  }

  const exportXlsx = async () => {
    setExporting('xlsx')
    try {
      const { default: writeExcelFile } = await import('write-excel-file/universal')
      const sheet = sheetXlsx({ rows, average, date: day })
      const blob = await writeExcelFile(sheet.data, { columns: sheet.columns, sheet: sheet.sheet }).toBlob()
      download(blob, sheetFilename(day, 'xlsx'))
    } catch (err) {
      toast.error('Export failed: ' + (err.message || err))
    } finally {
      setExporting(null)
    }
  }

  const saveGrams = async (row, value) => {
    setEditing(null)
    const item = logs.flatMap((l) => l.meal_items || []).find((i) => i.id === row.item_id)
    const grams = toNumber(value)
    if (!item || grams == null || grams < 0 || grams === toNumber(item.grams)) return
    let patch
    if (item.recipe_id) {
      const perPortion = toNumber(item.grams) / (toNumber(item.portions) || 1)
      patch = { portions: Math.max(0.05, Math.min(20, round1(grams / (perPortion || 1)))) }
    } else if (item.food_id) {
      patch = { grams }
    } else {
      const scale = toNumber(item.grams) ? grams / toNumber(item.grams) : 1
      patch = {
        grams,
        kcal: Math.round((toNumber(item.kcal) ?? 0) * scale),
        protein_g: round1((toNumber(item.protein_g) ?? 0) * scale),
        carbs_g: round1((toNumber(item.carbs_g) ?? 0) * scale),
        fat_g: round1((toNumber(item.fat_g) ?? 0) * scale),
      }
    }
    const { error: upErr } = await supabase.from('meal_items').update(patch).eq('id', item.id)
    if (!upErr) await supabase.from('meal_logs').update({ status: 'edited' }).eq('id', item.meal_id)
    if (upErr) toast.error('Not saved: ' + upErr.message)
    else toast.success('Updated ✓')
    await load()
    onChanged?.()
  }

  const removeItem = async (row) => {
    const { error: delErr } = await supabase.from('meal_items').delete().eq('id', row.item_id)
    if (delErr) {
      toast.error('Could not delete: ' + delErr.message)
      return
    }
    await supabase.from('meal_logs').update({ status: 'edited' }).eq('id', row.meal_id)
    await load()
    onChanged?.()
  }

  const num = (n) => (n == null ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }))

  return (
    <section className="bg-card rounded-3xl p-4 sm:p-6 border border-white/5 space-y-4" aria-label="Daily sheet">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onDayChange(addDays(day, -1))} className="min-w-[48px] min-h-[48px] rounded-xl bg-white/5 text-white" aria-label="Previous day">
          ‹
        </button>
        <label htmlFor="sheet-day" className="sr-only">
          Day
        </label>
        <input
          id="sheet-day"
          type="date"
          value={day}
          max={today}
          onChange={(e) => e.target.value && onDayChange(e.target.value)}
          className="flex-1 min-w-0 px-3 py-3 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[48px]"
        />
        <button
          type="button"
          onClick={() => onDayChange(addDays(day, 1))}
          disabled={day >= today}
          className="min-w-[48px] min-h-[48px] rounded-xl bg-white/5 text-white disabled:opacity-30"
          aria-label="Next day"
        >
          ›
        </button>
      </div>
      <p className="text-xs text-muted">{formatDate(day)}</p>

      {loading ? (
        <SkeletonRows count={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {/* relative: without it, the sr-only label in the last header cell
              (position: absolute) is laid out against the page rather than
              this scroller, sits 640 px across, and widens the whole page on a
              phone. Found in the Phase 1 browser check (390 px viewport, page
              634 px wide, taps landing off target). */}
          <div className="relative overflow-x-auto -mx-4 sm:mx-0">
            {/* On screen, time and meal share one narrow two-line cell so kcal
                and protein fit on a 390 px phone without scrolling (found in
                the Phase 1 browser check). The CSV and XLSX keep all eight
                columns of the spec separate. */}
            <table className="min-w-[520px] w-full text-sm tabular-nums border-separate border-spacing-0">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-muted">
                  <th scope="col" className="py-2 pl-4 sm:pl-2 pr-2 font-semibold border-b border-white/10 text-left">
                    Time
                  </th>
                  {SHEET_COLUMNS.filter((c) => c.key !== 'time' && c.key !== 'meal').map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={`py-2 px-2 font-semibold border-b border-white/10 ${c.numeric ? 'text-right' : 'text-left'} ${c.key === 'item' ? 'sticky left-0 bg-card z-10' : ''}`}
                    >
                      {c.label}
                    </th>
                  ))}
                  <th scope="col" className="border-b border-white/10">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={SHEET_COLUMNS.length} className="py-6 text-center text-muted">
                      Nothing logged on this day.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.item_id} className="text-white">
                    <td className="py-2 pl-4 sm:pl-2 pr-2 border-b border-white/5 text-muted leading-tight">
                      <span className="block">{r.time}</span>
                      <span className="block text-[10px]">{r.meal}</span>
                    </td>
                    <th scope="row" className="py-2 px-2 border-b border-white/5 text-left font-normal sticky left-0 bg-card z-10 max-w-[150px] truncate">
                      {r.item}
                      {r.hidden && <span className="text-[10px] text-muted"> (hidden)</span>}
                    </th>
                    <td className="py-1 px-2 border-b border-white/5 text-right">
                      {editing === r.item_id ? (
                        <input
                          type="number"
                          inputMode="decimal"
                          defaultValue={r.grams}
                          aria-label={`Grams of ${r.item}`}
                          // The cell was just tapped to edit it, so focus moves into it.
                          autoFocus
                          onBlur={(e) => saveGrams(r, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur()
                            if (e.key === 'Escape') setEditing(null)
                          }}
                          className="w-20 px-2 py-1 bg-background border border-accent rounded-lg text-right text-white"
                        />
                      ) : (
                        <button type="button" onClick={() => setEditing(r.item_id)} className="min-h-[40px] px-2 -mx-2 rounded-lg hover:bg-white/5 underline decoration-dotted decoration-white/30" aria-label={`Edit grams of ${r.item}, now ${r.grams}`}>
                          {num(r.grams)}
                        </button>
                      )}
                    </td>
                    <td className="py-2 px-2 border-b border-white/5 text-right font-bold">{num(r.kcal)}</td>
                    <td className="py-2 px-2 border-b border-white/5 text-right">{num(r.protein_g)}</td>
                    <td className="py-2 px-2 border-b border-white/5 text-right">{num(r.carbs_g)}</td>
                    <td className="py-2 px-2 border-b border-white/5 text-right">{num(r.fat_g)}</td>
                    <td className="py-1 px-1 border-b border-white/5 text-right">
                      <button type="button" onClick={() => removeItem(r)} className="min-w-[40px] min-h-[40px] rounded-full text-muted hover:text-red-300" aria-label={`Remove ${r.item}`}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-white font-extrabold">
                  <td className="py-2 px-2" />
                  <th scope="row" className="py-2 px-2 text-left sticky left-0 bg-card z-10">
                    Day total
                  </th>
                  <td className="py-2 px-2 text-right">{num(totals.grams)}</td>
                  <td className="py-2 px-2 text-right">{num(totals.kcal)}</td>
                  <td className="py-2 px-2 text-right">{num(totals.protein_g)}</td>
                  <td className="py-2 px-2 text-right">{num(totals.carbs_g)}</td>
                  <td className="py-2 px-2 text-right">{num(totals.fat_g)}</td>
                  <td />
                </tr>
                <tr className="text-muted">
                  <td className="py-2 px-2" />
                  <th scope="row" className="py-2 px-2 text-left font-semibold sticky left-0 bg-card z-10">
                    7-day average{average ? ` (${average.days} day${average.days === 1 ? '' : 's'} logged)` : ''}
                  </th>
                  <td className="py-2 px-2 text-right" />
                  <td className="py-2 px-2 text-right">{average ? num(average.kcal) : '–'}</td>
                  <td className="py-2 px-2 text-right">{average ? num(average.protein_g) : '–'}</td>
                  <td className="py-2 px-2 text-right">{average ? num(average.carbs_g) : '–'}</td>
                  <td className="py-2 px-2 text-right">{average ? num(average.fat_g) : '–'}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={exportCsv} disabled={rows.length === 0} className="min-h-[48px] rounded-xl bg-white/5 border border-white/10 text-white text-sm font-bold disabled:opacity-40">
              ⬇ CSV
            </button>
            <button type="button" onClick={exportXlsx} disabled={rows.length === 0 || exporting != null} className="min-h-[48px] rounded-xl bg-white/5 border border-white/10 text-white text-sm font-bold disabled:opacity-40">
              {exporting === 'xlsx' ? 'Preparing…' : '⬇ XLSX'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
