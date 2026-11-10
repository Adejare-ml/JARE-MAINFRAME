/**
 * Diet: the Daily Sheet as rows, totals, CSV and XLSX.
 *
 * One row per meal item (time, meal, item, grams, kcal, protein, carbs,
 * fat), a day total that is the sum of those rows, and the 7-day average.
 * The total is computed from the rows the sheet prints, never read from
 * meal_logs, so the done-criterion "Daily Sheet totals equal the sum of the
 * items" holds on the page and in both files by construction. (The database
 * keeps meal_logs totals equal to their items too, with a trigger; see
 * migration 048 and scripts/db-test.mjs.)
 *
 * The CSV goes through ../export.js toCsv, so it gets the same BOM, CRLF
 * line endings and formula-injection guard as every other export. The XLSX
 * is described here as plain data for write-excel-file; the browser loads
 * that library only when Export is tapped (see DailySheet.jsx), so it costs
 * nothing on an ordinary page load.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { toCsv } from '../export.js'
import { toNumber, sumNutrition, round1 } from './nutrition.js'
import { localTime, SLOT_LABELS, normaliseSlot } from './totals.js'

export const SHEET_COLUMNS = [
  { key: 'time', label: 'Time' },
  { key: 'meal', label: 'Meal' },
  { key: 'item', label: 'Item' },
  { key: 'grams', label: 'Grams', numeric: true },
  { key: 'kcal', label: 'kcal', numeric: true },
  { key: 'protein_g', label: 'Protein (g)', numeric: true },
  { key: 'carbs_g', label: 'Carbs (g)', numeric: true },
  { key: 'fat_g', label: 'Fat (g)', numeric: true },
]

/**
 * @param {Array<{id: string, eaten_at: string, meal_slot: string, meal_items: Array}>} logs - one day, with their items
 * @returns {Array<{meal_id: string, time: string, meal: string, item: string, grams: number,
 *   kcal: number, protein_g: number, carbs_g: number, fat_g: number, hidden: boolean}>}
 */
export function sheetRows(logs) {
  const sorted = [...(logs || [])].filter(Boolean).sort((a, b) => String(a.eaten_at).localeCompare(String(b.eaten_at)))
  const rows = []
  for (const log of sorted) {
    const items = [...(log.meal_items || [])].sort((a, b) => (toNumber(a.position) ?? 0) - (toNumber(b.position) ?? 0))
    for (const it of items) {
      rows.push({
        meal_id: log.id,
        item_id: it.id ?? null,
        time: localTime(log.eaten_at),
        meal: SLOT_LABELS[normaliseSlot(log.meal_slot)],
        item: it.name,
        grams: round1(it.grams),
        kcal: Math.round(toNumber(it.kcal) ?? 0),
        protein_g: round1(it.protein_g),
        carbs_g: round1(it.carbs_g),
        fat_g: round1(it.fat_g),
        hidden: it.hidden === true,
      })
    }
  }
  return rows
}

/** The day total: the sum of the rows. */
export function sheetTotals(rows) {
  return { grams: round1((rows || []).reduce((a, r) => a + (toNumber(r.grams) ?? 0), 0)), ...sumNutrition(rows) }
}

function averageLabel(average) {
  return `7-day average (${average.days} day${average.days === 1 ? '' : 's'} logged)`
}

/** The rows the files write: items, the day total, then the average if there is one. */
function fileRows({ rows, average }) {
  const totals = sheetTotals(rows)
  const out = rows.map((r) => Object.fromEntries(SHEET_COLUMNS.map((c) => [c.label, r[c.key]])))
  out.push({ Time: null, Meal: null, Item: 'Day total', Grams: totals.grams, kcal: totals.kcal, 'Protein (g)': totals.protein_g, 'Carbs (g)': totals.carbs_g, 'Fat (g)': totals.fat_g })
  if (average) {
    out.push({ Time: null, Meal: null, Item: averageLabel(average), Grams: null, kcal: average.kcal, 'Protein (g)': average.protein_g, 'Carbs (g)': average.carbs_g, 'Fat (g)': average.fat_g })
  }
  return out
}

/**
 * @param {{rows: Array, average: object|null}} args
 * @returns {string} CSV, BOM-prefixed, CRLF
 */
export function sheetCsv({ rows, average }) {
  return toCsv(fileRows({ rows, average }), SHEET_COLUMNS.map((c) => c.label))
}

/**
 * The sheet as write-excel-file data: a header row in bold, numbers typed
 * as numbers so Excel can sum them, the total and average rows in bold.
 *
 * @param {{rows: Array, average: object|null, date?: string}} args
 * @returns {{data: Array<Array<object|null>>, columns: Array<{width: number}>, sheet: string}}
 */
export function sheetXlsx({ rows, average, date }) {
  const body = fileRows({ rows, average })
  const header = SHEET_COLUMNS.map((c) => ({ value: c.label, fontWeight: 'bold' }))
  const data = [header]
  body.forEach((row, i) => {
    const summary = i >= rows.length
    data.push(
      SHEET_COLUMNS.map((c) => {
        const v = row[c.label]
        if (v == null || v === '') return null
        return c.numeric
          ? { value: Number(v), type: Number, ...(summary ? { fontWeight: 'bold' } : {}) }
          : { value: String(v), type: String, ...(summary ? { fontWeight: 'bold' } : {}) }
      }),
    )
  })
  return {
    data,
    columns: [{ width: 7 }, { width: 11 }, { width: 34 }, { width: 8 }, { width: 8 }, { width: 11 }, { width: 10 }, { width: 8 }],
    sheet: date ? `Diet ${date}` : 'Diet',
  }
}

/** `jare-diet-2026-11-10.csv` */
export function sheetFilename(date, ext) {
  return `jare-diet-${date}.${ext}`
}
