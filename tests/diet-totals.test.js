import { describe, it, expect } from 'vitest'
import { dayTotals, remaining, sevenDayAverage, localDay, localTime, addDays, slotForHour, SLOTS } from '../src/lib/diet/totals.js'

// Daily totals, what is left, and the rolling 7-day average
// (docs/diet-module.md, sections 2 and 3).

const logs = [
  { meal_slot: 'breakfast', kcal: 450, protein_g: 21, carbs_g: 50, fat_g: 18 },
  { meal_slot: 'lunch', kcal: 804, protein_g: 44.9, carbs_g: 115.4, fat_g: 14 },
  { meal_slot: 'snacks', kcal: '170', protein_g: '7.3', carbs_g: '5.1', fat_g: '14.2' },
]

describe('dayTotals', () => {
  it('sums the day and each slot', () => {
    const t = dayTotals(logs)
    expect(t).toMatchObject({ kcal: 1424, protein_g: 73.2, carbs_g: 170.5, fat_g: 46.2, count: 3 })
    expect(t.bySlot.lunch.kcal).toBe(804)
    expect(t.bySlot.dinner.kcal).toBe(0)
    expect(Object.keys(t.bySlot)).toEqual(SLOTS)
  })

  it('files an unknown slot under snacks rather than losing it', () => {
    expect(dayTotals([{ meal_slot: 'brunch', kcal: 100 }]).bySlot.snacks.kcal).toBe(100)
  })
})

describe('remaining', () => {
  const settings = { kcal_target: 2300, protein_target_g: 100 }

  it('is what is left of both targets', () => {
    expect(remaining(dayTotals(logs), settings)).toMatchObject({ kcal_left: 876, protein_left: 26.8, over: false, protein_met: false })
  })

  it('goes negative on kcal and stops at zero on protein, which is a floor not a ceiling', () => {
    const r = remaining({ kcal: 2500, protein_g: 130 }, settings)
    expect(r).toMatchObject({ kcal_left: -200, protein_left: 0, over: true, protein_met: true })
  })

  it('is null without targets, so the ring draws an empty track', () => {
    expect(remaining({ kcal: 500, protein_g: 10 }, {})).toMatchObject({ kcal_left: null, protein_left: null, kcal_ratio: null })
  })
})

describe('sevenDayAverage', () => {
  const days = [
    { eaten_on: '2026-11-10', kcal: 2000, protein_g: 100, carbs_g: 200, fat_g: 70 },
    { eaten_on: '2026-11-08', kcal: 2600, protein_g: 80, carbs_g: 300, fat_g: 90 },
    { eaten_on: '2026-11-04', kcal: 1900, protein_g: 120, carbs_g: 180, fat_g: 60 },
    // Eight days before: outside the window.
    { eaten_on: '2026-11-03', kcal: 5000, protein_g: 1, carbs_g: 1, fat_g: 1 },
  ]

  it('averages the logged days in the seven days ending on the given day', () => {
    expect(sevenDayAverage(days, '2026-11-10')).toEqual({ days: 3, kcal: 2167, protein_g: 100, carbs_g: 226.7, fat_g: 73.3 })
  })

  it('skips days with nothing logged instead of counting them as zero', () => {
    expect(sevenDayAverage(days, '2026-11-10').days).toBe(3)
  })

  it('is null when nothing was logged in the window', () => {
    expect(sevenDayAverage(days, '2026-12-01')).toBe(null)
  })
})

describe('days and times in Lagos', () => {
  it('puts a late meal on the Lagos day, not the UTC one', () => {
    expect(localDay(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-11')
    expect(localDay('2026-11-10T22:59:00Z')).toBe('2026-11-10')
  })

  it('reads the Lagos clock time', () => {
    expect(localTime('2026-11-10T12:05:00Z')).toBe('13:05')
  })

  it('steps days across a month end', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01')
    expect(addDays('2026-11-03', -6)).toBe('2026-10-28')
  })
})

describe('slotForHour', () => {
  it('guesses the slot from the hour', () => {
    expect(slotForHour(7)).toBe('breakfast')
    expect(slotForHour(13)).toBe('lunch')
    expect(slotForHour(19)).toBe('dinner')
    expect(slotForHour(16)).toBe('snacks')
    expect(slotForHour(23)).toBe('snacks')
  })
})
