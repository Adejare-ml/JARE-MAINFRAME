import { describe, it, expect } from 'vitest'
import { nutritionFor, sumNutrition, round1, toNumber, cleanItem, ITEM_LIMITS } from '../src/lib/diet/nutrition.js'

// The arithmetic every Diet screen and the database agree on. Written before
// src/lib/diet/nutrition.js, per the Diet build spec (docs/diet-module.md,
// section 3): kcal is a whole number per item, macros one decimal place, and
// a meal is the sum of its items.

const rice = { kcal_per_100g: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3 }

describe('nutritionFor', () => {
  it('scales the per-100 g figures by the grams eaten', () => {
    expect(nutritionFor(rice, 250)).toEqual({ kcal: 325, protein_g: 6.8, carbs_g: 70.5, fat_g: 0.8 })
  })

  it('rounds kcal to a whole number and macros to one place', () => {
    const r = nutritionFor({ kcal_per_100g: 333, protein_g: 1.11, carbs_g: 0, fat_g: 0 }, 33)
    expect(r.kcal).toBe(110)
    expect(r.protein_g).toBe(0.4)
  })

  it('treats zero and missing grams as nothing eaten', () => {
    expect(nutritionFor(rice, 0)).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
    expect(nutritionFor(rice, null)).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
  })

  it('treats a missing macro as zero rather than failing the item', () => {
    expect(nutritionFor({ kcal_per_100g: 884 }, 10)).toEqual({ kcal: 88, protein_g: 0, carbs_g: 0, fat_g: 0 })
  })

  it('refuses negative grams and caps absurd ones', () => {
    expect(nutritionFor(rice, -50).kcal).toBe(0)
    expect(nutritionFor(rice, 99999).kcal).toBe(Math.round((ITEM_LIMITS.grams * 130) / 100))
  })
})

describe('sumNutrition', () => {
  it('adds the items, so a meal is always the sum of what is under it', () => {
    const items = [
      { kcal: 325, protein_g: 6.8, carbs_g: 70.5, fat_g: 0.8 },
      { kcal: 154, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6 },
      { kcal: 0.4, protein_g: 0.1, carbs_g: 0.2, fat_g: 0.1 },
    ]
    // 0.1 + 0.2 is the classic float trap; one decimal place comes back exact.
    expect(sumNutrition(items)).toEqual({ kcal: 479, protein_g: 19.5, carbs_g: 71.8, fat_g: 11.5 })
  })

  it('is zero for an empty meal', () => {
    expect(sumNutrition([])).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
    expect(sumNutrition(null)).toEqual({ kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 })
  })

  it('reads numbers sent as strings by PostgREST', () => {
    expect(sumNutrition([{ kcal: '100', protein_g: '2.5' }, { kcal: 50, protein_g: 1 }])).toEqual({ kcal: 150, protein_g: 3.5, carbs_g: 0, fat_g: 0 })
  })
})

describe('helpers', () => {
  it('round1 survives float noise', () => {
    expect(round1(0.1 + 0.2)).toBe(0.3)
    expect(round1(1.05)).toBe(1.1)
    expect(round1(null)).toBe(0)
  })

  it('toNumber accepts numbers, numeric strings and thousands separators', () => {
    expect(toNumber(5)).toBe(5)
    expect(toNumber('1,500')).toBe(1500)
    expect(toNumber('abc')).toBe(null)
    expect(toNumber(Infinity)).toBe(null)
  })
})

describe('cleanItem', () => {
  it('recomputes a food-matched item from the food, whatever figures came with it', () => {
    const item = cleanItem({ name: 'White rice', grams: 250, kcal: 9999, protein_g: 99 }, rice)
    expect(item).toMatchObject({ name: 'White rice', grams: 250, kcal: 325, protein_g: 6.8 })
  })

  it('keeps the given figures for an item with no food behind it, clamped', () => {
    const item = cleanItem({ name: '  Mystery   stew ', grams: '300', kcal: -5, protein_g: 12.34 })
    expect(item).toMatchObject({ name: 'Mystery stew', grams: 300, kcal: 0, protein_g: 12.3, hidden: false })
  })

  it('drops an item with no name', () => {
    expect(cleanItem({ name: '   ', grams: 100 })).toBe(null)
  })
})
