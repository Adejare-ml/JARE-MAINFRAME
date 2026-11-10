import { describe, it, expect } from 'vitest'
import { DEFAULT_SPLIT, parseSplit, splitToPercents, percentsToSplit, validateSettings, slotBudget } from '../src/lib/diet/settings.js'

// The Diet settings screen's rules (docs/diet-module.md, section 2).

describe('meal split', () => {
  it('defaults to 20 / 35 / 30 / 15 and adds up to the whole day', () => {
    expect(DEFAULT_SPLIT).toEqual({ breakfast: 0.2, lunch: 0.35, dinner: 0.3, snacks: 0.15 })
    expect(Object.values(DEFAULT_SPLIT).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })

  it('falls back to the default for a stored split that is broken', () => {
    expect(parseSplit(null)).toEqual(DEFAULT_SPLIT)
    expect(parseSplit({ breakfast: 0.5 })).toEqual(DEFAULT_SPLIT)
    expect(parseSplit({ breakfast: 0.25, lunch: 0.25, dinner: 0.25, snacks: 0.25 })).toEqual({ breakfast: 0.25, lunch: 0.25, dinner: 0.25, snacks: 0.25 })
  })

  it('round-trips through the percentages the screen edits', () => {
    expect(splitToPercents(DEFAULT_SPLIT)).toEqual({ breakfast: 20, lunch: 35, dinner: 30, snacks: 15 })
    expect(percentsToSplit({ breakfast: 20, lunch: 35, dinner: 30, snacks: 15 })).toEqual({ ok: true, split: DEFAULT_SPLIT })
  })

  it('refuses percentages that do not add to 100', () => {
    const r = percentsToSplit({ breakfast: 20, lunch: 35, dinner: 30, snacks: 10 })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/95/)
  })

  it('gives each slot its share of the target', () => {
    expect(slotBudget({ kcal_target: 2300 }, 'lunch')).toBe(805)
    expect(slotBudget({}, 'lunch')).toBe(null)
  })
})

describe('validateSettings', () => {
  const form = {
    display_name: 'Ade',
    city: 'Abuja',
    sex: 'male',
    birth_year: '1996',
    height_cm: '180',
    weight_kg: '100',
    kcal_target: '2,200',
    protein_target_g: '120',
    activity_factor: '1.375',
    split: { breakfast: 20, lunch: 35, dinner: 30, snacks: 15 },
    avoid_foods: 'onions, okra ,',
    substitutes: 'cabbage and carrots',
    photo_retention_days: '',
  }

  it('turns the form into a row', () => {
    const r = validateSettings(form, new Date('2026-11-10'))
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({
      sex: 'male',
      birth_year: 1996,
      height_cm: 180,
      weight_kg: 100,
      kcal_target: 2200,
      protein_target_g: 120,
      activity_factor: 1.375,
      meal_split: DEFAULT_SPLIT,
      avoid_foods: ['onions', 'okra'],
      photo_retention_days: null,
    })
  })

  it('leaves optional fields empty rather than inventing them', () => {
    const r = validateSettings({ split: { breakfast: 20, lunch: 35, dinner: 30, snacks: 15 } })
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ height_cm: null, kcal_target: null, sex: null, avoid_foods: [] })
  })

  it('names each field that is out of range', () => {
    const r = validateSettings({ ...form, height_cm: '18', kcal_target: '200', birth_year: '2030' }, new Date('2026-11-10'))
    expect(r.ok).toBe(false)
    expect(Object.keys(r.errors).sort()).toEqual(['birth_year', 'height_cm', 'kcal_target'])
  })
})

describe('validateSettings, model IDs and photo retention (Phase 3)', () => {
  const base = { split: { breakfast: 20, lunch: 35, dinner: 30, snacks: 15 } }

  it('keeps model IDs as typed, and empty as null (the defaults apply)', () => {
    const r = validateSettings({ ...base, nvidia_vision_model: ' meta/llama-3.2-90b-vision-instruct ', ollama_vision_model: 'qwen3-vl:8b', photo_retention_days: '90' })
    expect(r.ok).toBe(true)
    expect(r.value).toMatchObject({ nvidia_vision_model: 'meta/llama-3.2-90b-vision-instruct', ollama_vision_model: 'qwen3-vl:8b', photo_retention_days: 90 })
    expect(validateSettings(base).value).toMatchObject({ nvidia_vision_model: null, ollama_vision_model: null, photo_retention_days: null })
  })

  it('refuses a model ID with spaces or odd characters', () => {
    const r = validateSettings({ ...base, ollama_vision_model: 'qwen vl; rm -rf' })
    expect(r.ok).toBe(false)
    expect(r.errors.ollama_vision_model).toMatch(/model ID/)
  })
})
