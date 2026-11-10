import { describe, it, expect } from 'vitest'
import { bmr, maintenance, ageIn, proposeTarget, reviewDue, KCAL_FLOOR, REVIEW_DAYS } from '../src/lib/diet/target.js'

// The 14-day target recalculation (docs/diet-module.md, section 3).
// Mifflin-St Jeor, activity factor 1.375, never below 1,800 kcal, and the
// gap between maintenance and target kept as it is. The fixtures are
// invented numbers, not the owner's: the repo is public.

const now = new Date('2026-11-10T09:00:00Z')

describe('bmr and maintenance', () => {
  it('is Mifflin-St Jeor', () => {
    expect(bmr({ weightKg: 100, heightCm: 180, age: 30, sex: 'male' })).toBe(1980)
    expect(bmr({ weightKg: 100, heightCm: 180, age: 30, sex: 'female' })).toBe(1814)
  })

  it('multiplies by the activity factor, 1.375 by default', () => {
    expect(maintenance({ weightKg: 100, heightCm: 180, age: 30, sex: 'male' })).toBe(2722.5)
    expect(maintenance({ weightKg: 100, heightCm: 180, age: 30, sex: 'male', activityFactor: 1.2 })).toBe(2376)
  })

  it('is null when a measurement is missing', () => {
    expect(bmr({ weightKg: 100, heightCm: null, age: 30, sex: 'male' })).toBe(null)
    expect(maintenance({ weightKg: 100, heightCm: 180, age: null, sex: 'male' })).toBe(null)
  })
})

describe('ageIn', () => {
  it('is the year minus the birth year', () => {
    expect(ageIn(1996, now)).toBe(30)
    expect(ageIn(null, now)).toBe(null)
  })
})

describe('proposeTarget', () => {
  const settings = { sex: 'male', height_cm: 180, weight_kg: 100, birth_year: 1996, activity_factor: 1.375, kcal_target: 2200 }

  it('keeps the gap below maintenance and moves with the new weight', () => {
    // Maintenance at 100 kg is 2,722.5, so the gap is 522.5. At 96 kg
    // maintenance is 2,667.5; minus the gap is 2,145, rounded to 2,150.
    const p = proposeTarget({ settings, latestWeightKg: 96, now })
    expect(p).toMatchObject({ kcal_target: 2150, maintenance: 2668, previous_target: 2200, weight_kg: 96 })
  })

  it('never proposes below 1,800 kcal', () => {
    const p = proposeTarget({ settings: { ...settings, kcal_target: 1800 }, latestWeightKg: 70, now })
    expect(p.kcal_target).toBe(KCAL_FLOOR)
  })

  it('proposes nothing when the measurements to compute it are missing', () => {
    expect(proposeTarget({ settings: { ...settings, birth_year: null }, latestWeightKg: 96, now })).toBe(null)
    expect(proposeTarget({ settings, latestWeightKg: null, now })).toBe(null)
  })

  it('takes no account of exercise: activity is in the factor, never added back', () => {
    const p = proposeTarget({ settings, latestWeightKg: 96, now, exerciseKcal: 600 })
    expect(p.kcal_target).toBe(2150)
  })
})

describe('reviewDue', () => {
  it('is due every 14 days, and at once when never reviewed', () => {
    expect(REVIEW_DAYS).toBe(14)
    expect(reviewDue(null, now)).toBe(true)
    expect(reviewDue('2026-10-28T09:00:00Z', now)).toBe(false)
    expect(reviewDue('2026-10-27T09:00:00Z', now)).toBe(true)
  })
})
