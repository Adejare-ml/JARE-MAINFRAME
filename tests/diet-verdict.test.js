import { describe, it, expect } from 'vitest'
import { mealVerdict } from '../src/lib/diet/verdict.js'

// The verdict rules (docs/diet-module.md, section 3), computed in code for
// saved meals and used to check the coach's answer in Phase 4.
//
//   fits:  the slot, this meal included, stays inside its share of the day
//   tight: the slot goes over its share, but the day can still end under target
//   over:  the day can no longer end under target

const settings = { kcal_target: 2300, meal_split: { breakfast: 0.2, lunch: 0.35, dinner: 0.3, snacks: 0.15 } }
const breakfast = { meal_slot: 'breakfast', kcal: 400 }

describe('mealVerdict', () => {
  it('fits when the slot stays inside its share', () => {
    const v = mealVerdict({ settings, slot: 'lunch', meal: { kcal: 800, protein_g: 46 }, earlier: [breakfast] })
    expect(v.verdict).toBe('fits')
    expect(v.reason).toBe('800 kcal and 46 g protein. Leaves you 1,100 kcal for the rest of the day.')
  })

  it('fits on the boundary: exactly the slot share is inside it', () => {
    expect(mealVerdict({ settings, slot: 'lunch', meal: { kcal: 805 }, earlier: [] }).verdict).toBe('fits')
  })

  it('counts earlier meals in the same slot against its share', () => {
    const v = mealVerdict({ settings, slot: 'lunch', meal: { kcal: 400 }, earlier: [{ meal_slot: 'lunch', kcal: 500 }] })
    expect(v.verdict).toBe('tight')
  })

  it('is tight when the slot runs over but the day can still end under target', () => {
    const v = mealVerdict({ settings, slot: 'lunch', meal: { kcal: 1000, protein_g: 30 }, earlier: [breakfast] })
    expect(v.verdict).toBe('tight')
    expect(v.reason).toBe('1,000 kcal and 30 g protein. 195 kcal past the lunch share of 805. Leaves you 900 kcal for the rest of the day.')
  })

  it('is tight, not over, when the meal lands the day exactly on target', () => {
    const v = mealVerdict({ settings, slot: 'dinner', meal: { kcal: 1100 }, earlier: [{ meal_slot: 'lunch', kcal: 1200 }] })
    expect(v.verdict).toBe('tight')
    expect(v.left).toBe(0)
  })

  it('is over when the day can no longer end under target', () => {
    const v = mealVerdict({ settings, slot: 'dinner', meal: { kcal: 600, protein_g: 25 }, earlier: [{ meal_slot: 'lunch', kcal: 1800 }] })
    expect(v.verdict).toBe('over')
    expect(v.reason).toBe('600 kcal and 25 g protein. That puts the day 100 kcal over target.')
  })

  it('has no verdict without a target', () => {
    expect(mealVerdict({ settings: {}, slot: 'lunch', meal: { kcal: 500 }, earlier: [] }).verdict).toBe(null)
  })

  it('uses the default split when none is stored', () => {
    expect(mealVerdict({ settings: { kcal_target: 2000 }, slot: 'snacks', meal: { kcal: 300 }, earlier: [] }).slotBudget).toBe(300)
  })

  it('writes plain sentences with no em dashes', () => {
    const v = mealVerdict({ settings, slot: 'lunch', meal: { kcal: 1000 }, earlier: [breakfast] })
    expect(v.reason).not.toMatch(/—/)
  })
})
