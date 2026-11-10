import { describe, it, expect } from 'vitest'
import { yesterdayNumbers, shoppingList, modelScorecard, checkinPush, checkinPlanInput } from '../src/lib/diet/checkin.js'

// The daily check-in (scripts/diet-checkin.mjs): the numbers are worked out
// here, in code; a model only writes the plan. Added after Phase 4.

const settings = { kcal_target: 2300, protein_target_g: 100, avoid_foods: ['onions'] }

describe('yesterdayNumbers', () => {
  it('sums the meals and compares them with the targets', () => {
    const logs = [
      { kcal: 900, protein_g: 40, meal_slot: 'lunch', status: 'confirmed' },
      { kcal: 1100, protein_g: 35.5, meal_slot: 'dinner', status: 'confirmed' },
    ]
    const y = yesterdayNumbers(logs, settings)
    expect(y).toMatchObject({ meals: 2, kcal: 2000, protein_g: 75.5, kcal_left: 300, protein_short: 24.5, verdict: 'under' })
  })

  it('calls a day over the target over, and an empty day empty', () => {
    expect(yesterdayNumbers([{ kcal: 2600, protein_g: 120 }], settings).verdict).toBe('over')
    expect(yesterdayNumbers([], settings)).toMatchObject({ meals: 0, verdict: 'empty' })
  })

  it('counts a day within 5% of the target as on target', () => {
    expect(yesterdayNumbers([{ kcal: 2250, protein_g: 100 }], settings).verdict).toBe('on target')
  })

  it('leaves the comparison out when no target is set', () => {
    const y = yesterdayNumbers([{ kcal: 1500, protein_g: 50 }], {})
    expect(y.kcal_left).toBeNull()
    expect(y.verdict).toBe('no target')
  })

  it('counts meals still waiting for a check', () => {
    expect(yesterdayNumbers([{ kcal: 500, protein_g: 10, status: 'auto' }], settings).unchecked).toBe(1)
  })
})

describe('shoppingList', () => {
  const foods = [
    { id: 'beans', name: 'Brown beans, dry' },
    { id: 'oil', name: 'Palm oil' },
    { id: 'carrot', name: 'Carrot' },
    { id: 'egg', name: 'Egg, boiled' },
    { id: 'plantain', name: 'Plantain, boiled' },
    { id: 'onion', name: 'Onion' },
  ]
  const ingredients = [
    { food_id: 'beans' }, { food_id: 'oil' }, { food_id: 'carrot' }, { food_id: 'onion' },
  ]
  const saved = [{ items: [{ food_id: 'egg', grams: 150 }, { food_id: 'plantain', grams: 180 }] }]

  it('lists the staples from recipes and saved meals, less what is in the pantry', () => {
    const pantry = [{ name: 'Palm oil', food_id: 'oil', finished: false }]
    const list = shoppingList({ foods, ingredients, saved, pantry, settings })
    expect(list.map((i) => i.name)).toEqual(['Brown beans', 'Carrot', 'Egg', 'Plantain'])
    expect(list.every((i) => i.why === 'staple')).toBe(true)
  })

  it('puts finished pantry items first and never lists an avoided food', () => {
    const pantry = [{ name: 'Groundnuts', food_id: null, finished: true }, { name: 'Onions', finished: true }]
    const list = shoppingList({ foods, ingredients, saved, pantry, settings })
    expect(list[0]).toEqual({ name: 'Groundnuts', why: 'finished' })
    expect(list.some((i) => /onion/i.test(i.name))).toBe(false)
  })

  it('does not list a finished item again when a fresh one is in the pantry', () => {
    const pantry = [
      { name: 'Carrot', food_id: 'carrot', finished: true },
      { name: 'Carrot', food_id: 'carrot', finished: false },
    ]
    const list = shoppingList({ foods, ingredients, saved, pantry, settings })
    expect(list.some((i) => i.name === 'Carrot')).toBe(false)
  })

  it('adds the extras the owner always wants, once', () => {
    const list = shoppingList({ foods, ingredients, saved, pantry: [], settings, extras: ['Cabbage', 'carrot'] })
    expect(list.filter((i) => /carrot/i.test(i.name))).toHaveLength(1)
    expect(list.some((i) => i.name === 'Cabbage')).toBe(true)
  })
})

describe('modelScorecard', () => {
  const meals = [
    { id: 'm1', status: 'confirmed', kcal: 1000 },
    { id: 'm2', status: 'edited', kcal: 500 },
    { id: 'm3', status: 'auto', kcal: 700 },
  ]
  const est = (meal_id, model_key, kcal, status = 'ok') => ({ meal_id, model_key, status, answer: status === 'ok' ? { totals: { kcal } } : null })

  it('scores each model by how far its total was from the meal the owner confirmed', () => {
    const rows = [est('m1', 'claude', 1100), est('m1', 'nvidia', 700), est('m2', 'claude', 450), est('m2', 'nvidia', 500), est('m3', 'claude', 9999)]
    const card = modelScorecard(rows, meals)
    const claude = card.find((c) => c.model === 'claude')
    const nvidia = card.find((c) => c.model === 'nvidia')
    expect(claude).toMatchObject({ meals: 2, error_pct: 10, closest: 1 })
    expect(nvidia).toMatchObject({ meals: 2, error_pct: 15, closest: 1 })
    expect(card[0].model).toBe('claude')
  })

  it('counts the answers that failed, and lists a model with none', () => {
    const card = modelScorecard([est('m1', 'ollama', null, 'invalid'), est('m1', 'claude', 1000)], meals)
    expect(card.find((c) => c.model === 'ollama')).toMatchObject({ meals: 0, failed: 1, error_pct: null })
    expect(card.find((c) => c.model === 'nvidia')).toMatchObject({ meals: 0, failed: 0 })
  })
})

describe('checkinPush', () => {
  it('fits the numbers, the plan and the list in a short push', () => {
    const push = checkinPush({
      yesterday: { meals: 3, kcal: 2000, protein_g: 75.5, kcal_left: 300, protein_short: 24.5, verdict: 'under', unchecked: 0 },
      plan: 'Breakfast: 3 eggs and plantain. Lunch: beans container.',
      shopping: [{ name: 'Eggs' }, { name: 'Carrot' }],
    })
    expect(push.title).toBe('Diet check-in')
    expect(push.body).toContain('Yesterday: 2,000 kcal, 75.5 g protein (300 under, 24.5 g protein short)')
    expect(push.body).toContain('Buy: Eggs, Carrot')
    expect(push.body.length).toBeLessThanOrEqual(400)
    expect(push.url).toBe('/diet')
  })

  it('says so when nothing was logged', () => {
    const push = checkinPush({ yesterday: { meals: 0, verdict: 'empty' }, plan: null, shopping: [] })
    expect(push.body).toContain('Nothing logged yesterday')
  })
})

describe('checkinPlanInput', () => {
  it('gives the model the targets, the pantry and the avoided foods, and no names', () => {
    const text = checkinPlanInput({
      settings: { ...settings, display_name: 'Someone' },
      yesterday: { meals: 1, kcal: 1500, protein_g: 60, verdict: 'under' },
      pantry: [{ name: 'Eggs', quantity: 12, unit: 'pcs', finished: false }],
      saved: [{ name: 'Beans container' }],
    })
    expect(text).toContain('2300 kcal')
    expect(text).toContain('Eggs (12 pcs)')
    expect(text).toContain('Never suggest: onions')
    expect(text).toContain('Beans container')
    expect(text).not.toContain('Someone')
  })
})
