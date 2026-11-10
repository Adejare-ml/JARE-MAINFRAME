import { describe, it, expect } from 'vitest'
import writeExcelFile from 'write-excel-file/node'
import readExcelFile from 'read-excel-file/node'
import { SHEET_COLUMNS, sheetRows, sheetTotals, sheetCsv, sheetXlsx, sheetFilename } from '../src/lib/diet/sheet.js'

// The Daily Sheet (docs/diet-module.md, section 4): one row per item, the
// day's totals, the 7-day average, and the same table as CSV and XLSX.
// "Daily Sheet totals equal the sum of the items" is a done-criterion of
// the build spec, so it is tested here and again against the database in
// scripts/db-test.mjs.

const logs = [
  {
    id: 'm2',
    eaten_at: '2026-11-10T12:30:00Z',
    meal_slot: 'lunch',
    meal_items: [
      { name: 'Beans pot', grams: 300.8, kcal: 804, protein_g: 44.9, carbs_g: 115.4, fat_g: 14, position: 0 },
      { name: 'Orange', grams: 130, kcal: 61, protein_g: 1.2, carbs_g: 15.3, fat_g: 0.2, position: 1 },
    ],
  },
  {
    id: 'm1',
    eaten_at: '2026-11-10T06:45:00Z',
    meal_slot: 'breakfast',
    meal_items: [
      { name: 'Palm oil (hidden)', grams: 10, kcal: 90, protein_g: 0, carbs_g: 0, fat_g: 10, position: 1, hidden: true },
      { name: 'Egg, boiled', grams: 150, kcal: 233, protein_g: 18.9, carbs_g: 1.7, fat_g: 15.9, position: 0 },
    ],
  },
]

describe('sheetRows', () => {
  it('lists every item in time order, then in the order it was logged', () => {
    const rows = sheetRows(logs)
    expect(rows.map((r) => r.item)).toEqual(['Egg, boiled', 'Palm oil (hidden)', 'Beans pot', 'Orange'])
    expect(rows[0]).toMatchObject({ time: '07:45', meal: 'Breakfast', grams: 150, kcal: 233 })
    expect(rows[2].time).toBe('13:30')
  })

  it('is empty for a day with nothing logged', () => {
    expect(sheetRows([])).toEqual([])
  })
})

describe('sheetTotals', () => {
  it('equals the sum of the items', () => {
    const rows = sheetRows(logs)
    const t = sheetTotals(rows)
    expect(t).toEqual({ grams: 590.8, kcal: 1188, protein_g: 65, carbs_g: 132.4, fat_g: 40.1 })
    for (const key of ['kcal', 'protein_g', 'carbs_g', 'fat_g']) {
      const byHand = Math.round(rows.reduce((a, r) => a + r[key], 0) * 10) / 10
      expect(t[key]).toBe(byHand)
    }
  })
})

describe('sheetCsv', () => {
  const average = { days: 5, kcal: 2167, protein_g: 98.4, carbs_g: 226.7, fat_g: 73.3 }

  it('writes the header, the items, the day total and the 7-day average', () => {
    const csv = sheetCsv({ rows: sheetRows(logs), average })
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n')
    expect(lines[0]).toBe(SHEET_COLUMNS.map((c) => c.label).join(','))
    expect(lines).toHaveLength(1 + 4 + 2)
    expect(lines[1]).toBe('07:45,Breakfast,"Egg, boiled",150,233,18.9,1.7,15.9')
    expect(lines[5]).toBe(',,Day total,590.8,1188,65,132.4,40.1')
    expect(lines[6]).toBe(',,7-day average (5 days logged),,2167,98.4,226.7,73.3')
  })

  it('leaves the average row out when there is no history', () => {
    const lines = sheetCsv({ rows: sheetRows(logs), average: null }).trim().split('\r\n')
    expect(lines).toHaveLength(1 + 4 + 1)
  })
})

describe('sheetXlsx', () => {
  it('builds a sheet a spreadsheet reads back with numbers as numbers', async () => {
    const data = sheetXlsx({ rows: sheetRows(logs), average: { days: 5, kcal: 2167, protein_g: 98.4, carbs_g: 226.7, fat_g: 73.3 } })
    const buffer = await writeExcelFile(data.data, { columns: data.columns, sheet: data.sheet }).toBuffer()
    const sheets = await readExcelFile(buffer)
    const rows = sheets[0].data
    expect(rows[0]).toEqual(SHEET_COLUMNS.map((c) => c.label))
    expect(rows[1]).toEqual(['07:45', 'Breakfast', 'Egg, boiled', 150, 233, 18.9, 1.7, 15.9])
    expect(rows[5].slice(2)).toEqual(['Day total', 590.8, 1188, 65, 132.4, 40.1])
    expect(rows[6][4]).toBe(2167)
  })
})

describe('sheetFilename', () => {
  it('names the file after the day', () => {
    expect(sheetFilename('2026-11-10', 'xlsx')).toBe('jare-diet-2026-11-10.xlsx')
  })
})
