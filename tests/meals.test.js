import { describe, it, expect } from 'vitest'
import {
  LIMITS,
  MEAL_TYPES,
  newItem,
  parseMealAnalysis,
  itemCalories,
  sumCalories,
  sumMacros,
  withQuantity,
  stepQuantity,
  quantityLabel,
  QUANTITY_STEPS,
  mealTypeFor,
  summarizeItems,
  dayTotals,
  targetProgress,
  parseCalorieTarget,
  daySeries,
  itemsForStorage,
  itemsFromMeal,
  repeatCandidates,
} from '../src/lib/meals.js'

const good = {
  is_food: true,
  meal_type: 'lunch',
  items: [
    { name: 'Jollof rice', portion: '2 cups', grams: 400, calories: 600, protein_g: 12, carbs_g: 110, fat_g: 14, confidence: 'high' },
    { name: 'Fried chicken', portion: '1 lap', grams: 180, calories: 350, confidence: 'medium', note: 'skin on' },
    { name: 'Coca-Cola', portion: '50 cl bottle', calories: 210, confidence: 'high' },
  ],
  total_calories: 9999,
  quality: { lighting: 'dark', sharpness: 'soft', obstructed: false },
  advice: 'Take it from above next time.',
}

describe('parseMealAnalysis', () => {
  it('keeps a good answer and recomputes the total itself', () => {
    const out = parseMealAnalysis(good)
    expect(out.ok).toBe(true)
    const a = out.analysis
    expect(a.is_food).toBe(true)
    expect(a.meal_type).toBe('lunch')
    expect(a.items).toHaveLength(3)
    expect(a.items[0].quantity).toBe(1)
    expect(a.items[1].note).toBe('skin on')
    expect(a.items[2].grams).toBeNull()
    expect(a.total_calories).toBe(1160)
    expect(a.quality).toEqual({ lighting: 'dark', sharpness: 'soft', obstructed: false })
    expect(a.advice).toBe('Take it from above next time.')
    expect(a.dropped).toBe(0)
  })

  it('accepts the raw JSON string too', () => {
    expect(parseMealAnalysis(JSON.stringify(good)).ok).toBe(true)
  })

  it('refuses what is not an object', () => {
    expect(parseMealAnalysis('not json').ok).toBe(false)
    expect(parseMealAnalysis(null).ok).toBe(false)
    expect(parseMealAnalysis([1, 2]).ok).toBe(false)
    expect(parseMealAnalysis(42).ok).toBe(false)
  })

  it('reports no food as a result, not a failure', () => {
    const out = parseMealAnalysis({ is_food: false, items: [], total_calories: 0, advice: 'No plate in view.' })
    expect(out.ok).toBe(true)
    expect(out.analysis.is_food).toBe(false)
    expect(out.analysis.items).toEqual([])
    expect(out.analysis.total_calories).toBe(0)
  })

  it('trusts the dishes over a wrong is_food flag', () => {
    const out = parseMealAnalysis({ is_food: false, items: [{ name: 'Eba', calories: 340 }] })
    expect(out.analysis.is_food).toBe(true)
  })

  it('drops nameless and malformed items, clamps numbers, defaults enums', () => {
    const out = parseMealAnalysis({
      items: [
        { name: '', calories: 100 },
        'rice',
        null,
        { name: '  Egusi   soup ', calories: -50, protein_g: -1, confidence: 'certain', grams: 99999 },
        { name: 'Pounded yam', calories: '1,200', fat_g: 'lots' },
        { name: 'Mystery', calories: 50000 },
      ],
      quality: { lighting: 'neon', sharpness: null },
    })
    const a = out.analysis
    expect(a.dropped).toBe(3)
    expect(a.items.map((i) => i.name)).toEqual(['Egusi soup', 'Pounded yam', 'Mystery'])
    expect(a.items[0].calories).toBe(0)
    expect(a.items[0].protein_g).toBe(0)
    expect(a.items[0].confidence).toBe('medium')
    expect(a.items[0].grams).toBe(LIMITS.grams)
    expect(a.items[1].calories).toBe(1200)
    expect(a.items[1].fat_g).toBeNull()
    expect(a.items[2].calories).toBe(LIMITS.itemCalories)
    expect(a.quality.lighting).toBe('good')
    expect(a.quality.sharpness).toBe('sharp')
    expect(a.meal_type).toBeNull()
    expect(a.advice).toBeNull()
  })

  it('caps the item count and the strings', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ name: `Item ${i} ${'x'.repeat(100)}`, calories: 10 }))
    const out = parseMealAnalysis({ items })
    expect(out.analysis.items).toHaveLength(LIMITS.items)
    expect(out.analysis.dropped).toBe(20 - LIMITS.items)
    expect(out.analysis.items[0].name.length).toBe(LIMITS.nameChars)
  })

  it('caps a meal at the ceiling', () => {
    const items = Array.from({ length: 5 }, () => ({ name: 'Nkwobi', calories: 3000 }))
    expect(parseMealAnalysis({ items }).analysis.total_calories).toBe(LIMITS.mealCalories)
  })
})

describe('quantities', () => {
  it('scales calories and macros by quantity and rounds', () => {
    const item = newItem({ name: 'Akara', calories: 80, protein_g: 3.3, quantity: 1 })
    expect(itemCalories(item)).toBe(80)
    expect(itemCalories(withQuantity(item, 3))).toBe(240)
    expect(itemCalories(withQuantity(item, 0.5))).toBe(40)
    expect(sumMacros([withQuantity(item, 3)])).toEqual({ protein_g: 9.9, carbs_g: 0, fat_g: 0 })
  })

  it('clamps a silly quantity', () => {
    expect(withQuantity({ calories: 100 }, 0).quantity).toBe(LIMITS.quantityMin)
    expect(withQuantity({ calories: 100 }, 99).quantity).toBe(LIMITS.quantityMax)
    expect(withQuantity({ calories: 100 }, 'x').quantity).toBe(1)
  })

  it('sums with quantity and treats a missing quantity as one', () => {
    expect(sumCalories([{ calories: 100 }, { calories: 50, quantity: 2 }])).toBe(200)
    expect(sumCalories([])).toBe(0)
    expect(sumCalories(null)).toBe(0)
  })

  it('has no macros when no item carried any', () => {
    expect(sumMacros([{ name: 'Water', calories: 0 }])).toBeNull()
  })

  it('steps through the offered quantities and stops at the ends', () => {
    expect(stepQuantity(1, +1)).toBe(1.5)
    expect(stepQuantity(1, -1)).toBe(0.75)
    expect(stepQuantity(3, +1)).toBe(3)
    expect(stepQuantity(0.5, -1)).toBe(0.5)
    expect(stepQuantity(1.2, +1)).toBe(1.5)
    expect(stepQuantity(1.2, -1)).toBe(1)
    expect(QUANTITY_STEPS).toContain(1)
  })

  it('labels quantities the way a person reads them', () => {
    expect(quantityLabel(1)).toBe('×1')
    expect(quantityLabel(2)).toBe('×2')
    expect(quantityLabel(0.5)).toBe('×½')
    expect(quantityLabel(1.5)).toBe('×1½')
    expect(quantityLabel(0.75)).toBe('×¾')
    expect(quantityLabel(1.2)).toBe('×1.2')
  })
})

describe('mealTypeFor', () => {
  it('follows the clock', () => {
    expect(mealTypeFor(7)).toBe('breakfast')
    expect(mealTypeFor(10)).toBe('breakfast')
    expect(mealTypeFor(13)).toBe('lunch')
    expect(mealTypeFor(16)).toBe('snack')
    expect(mealTypeFor(20)).toBe('dinner')
    expect(mealTypeFor(23)).toBe('snack')
    expect(mealTypeFor(2)).toBe('snack')
  })
  it('copes with nonsense', () => {
    expect(MEAL_TYPES).toContain(mealTypeFor(NaN))
    expect(mealTypeFor(-1)).toBe('snack')
    expect(mealTypeFor(25)).toBe('snack')
  })
})

describe('summarizeItems', () => {
  it('lists names with quantities where they are not one', () => {
    expect(summarizeItems([{ name: 'Jollof rice' }, { name: 'Chicken', quantity: 2 }, { name: 'Coke', quantity: 1 }])).toBe(
      'Jollof rice, Chicken ×2, Coke',
    )
  })
  it('truncates on a word boundary', () => {
    const s = summarizeItems([{ name: 'Pounded yam' }, { name: 'Egusi soup' }, { name: 'Assorted meat' }], 24)
    expect(s.length).toBeLessThanOrEqual(24)
    expect(s.endsWith('…')).toBe(true)
  })
  it('is empty for nothing', () => {
    expect(summarizeItems([])).toBe('')
    expect(summarizeItems(null)).toBe('')
  })
})

describe('dayTotals and targetProgress', () => {
  it('adds the day up by meal type', () => {
    const t = dayTotals([
      { calories: 400, meal_type: 'breakfast' },
      { calories: 800, meal_type: 'lunch' },
      { calories: 150, meal_type: 'nonsense' },
      { calories: -20, meal_type: 'dinner' },
    ])
    expect(t.calories).toBe(1350)
    expect(t.count).toBe(4)
    expect(t.byType).toEqual({ breakfast: 400, lunch: 800, dinner: 0, snack: 150 })
  })

  it('has no ratio without a target', () => {
    expect(targetProgress(500, null)).toEqual({ ratio: null, remaining: null, over: false, status: 'none' })
    expect(targetProgress(500, '').status).toBe('none')
  })

  it('reports under, near and over', () => {
    expect(targetProgress(1000, 2200).status).toBe('under')
    expect(targetProgress(1000, 2200).remaining).toBe(1200)
    expect(targetProgress(1900, 2200).status).toBe('near')
    expect(targetProgress(2500, 2200).status).toBe('over')
    expect(targetProgress(2500, 2200).over).toBe(true)
    expect(targetProgress(2500, '2200').ratio).toBeCloseTo(1.136, 3)
  })
})

describe('parseCalorieTarget', () => {
  it('accepts a sensible number as text or number and refuses the rest', () => {
    expect(parseCalorieTarget('2200')).toBe(2200)
    expect(parseCalorieTarget(1800.4)).toBe(1800)
    expect(parseCalorieTarget('2,000')).toBe(2000)
    expect(parseCalorieTarget('abc')).toBeNull()
    expect(parseCalorieTarget(100)).toBeNull()
    expect(parseCalorieTarget(9000)).toBeNull()
    expect(parseCalorieTarget(null)).toBeNull()
  })
})

describe('daySeries', () => {
  it('fills the empty days and sums the rest, oldest first', () => {
    const series = daySeries(
      [
        { eaten_on: '2026-10-17', calories: 500 },
        { eaten_on: '2026-10-17', calories: 300 },
        { eaten_on: '2026-10-15', calories: 1200 },
        { eaten_on: '2026-10-01', calories: 999 },
      ],
      '2026-10-17',
      3,
    )
    expect(series).toEqual([
      { date: '2026-10-15', calories: 1200 },
      { date: '2026-10-16', calories: 0 },
      { date: '2026-10-17', calories: 800 },
    ])
  })
  it('crosses a month boundary', () => {
    const series = daySeries([], '2026-11-02', 4)
    expect(series.map((d) => d.date)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
  })
})

describe('storage and repeat', () => {
  it('strips client ids and junk before storing', () => {
    const rows = itemsForStorage([
      { id: 'abc', name: 'Eba', calories: 340, quantity: 1.5, extra: 'nope' },
      { id: 'x', name: '', calories: 10 },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('id')
    expect(rows[0]).not.toHaveProperty('extra')
    expect(rows[0].quantity).toBe(1.5)
    expect(rows[0].calories).toBe(340)
  })

  it('reads a stored meal back into editable items', () => {
    const items = itemsFromMeal({ items: [{ name: 'Moi moi', calories: 230, quantity: 2 }, { name: '' }] })
    expect(items).toHaveLength(1)
    expect(items[0].id).toBeTruthy()
    expect(items[0].quantity).toBe(2)
    expect(itemsFromMeal({})).toEqual([])
    expect(itemsFromMeal(null)).toEqual([])
  })

  it('offers distinct recent meals, newest first, with their calories', () => {
    const meals = [
      { created_at: '2026-10-15T08:00:00Z', items: [{ name: 'Pap', calories: 150 }, { name: 'Akara', calories: 80, quantity: 4 }] },
      { created_at: '2026-10-16T13:00:00Z', items: [{ name: 'Jollof rice', calories: 600 }] },
      { created_at: '2026-10-17T13:00:00Z', items: [{ name: 'Jollof rice', calories: 600 }] },
      { created_at: '2026-10-17T20:00:00Z', items: [] },
    ]
    const picks = repeatCandidates(meals)
    expect(picks.map((p) => p.label)).toEqual(['Jollof rice', 'Pap, Akara ×4'])
    expect(picks[1].calories).toBe(470)
    expect(repeatCandidates(meals, 1)).toHaveLength(1)
  })
})
