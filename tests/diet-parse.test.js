import { describe, it, expect } from 'vitest'
import { matchParsed, pantryUpdates, parseNaira, scaleItem, PARSE_LIMITS } from '../src/lib/diet/parse.js'
import { buildLibrary } from '../src/lib/diet/library.js'

// Turning the model's answer (prompts/text-parse.md, validated by the
// diet-parse edge function) into an entry the review screen can show and
// log_diet_meal can store. Diet module, Phase 2.

const lib = buildLibrary({
  foods: [
    { id: 'egg', name: 'Egg, boiled', aliases: ['egg', 'eggs', 'boiled egg'], kcal_per_100g: 155, protein_g: 12.6, carbs_g: 1.1, fat_g: 10.6, typical_portion_g: 50 },
    { id: 'orange', name: 'Orange', aliases: ['oranges'], kcal_per_100g: 47, protein_g: 0.9, carbs_g: 11.8, fat_g: 0.1, typical_portion_g: 130 },
    { id: 'beans', name: 'Brown beans, dry', aliases: ['beans', 'honey beans'], kcal_per_100g: 340, protein_g: 22.5, carbs_g: 55, fat_g: 1.6 },
    { id: 'oil', name: 'Palm oil', aliases: ['red oil'], kcal_per_100g: 884, protein_g: 0, carbs_g: 0, fat_g: 100 },
  ],
  recipes: [{ id: 'pot', name: 'Beans pot', portions: 5 }],
  ingredients: [
    { recipe_id: 'pot', food_id: 'beans', grams: 1000 },
    { recipe_id: 'pot', food_id: 'oil', grams: 54 },
  ],
  saved: [{ id: 'bc', name: 'Beans container', items: [{ recipe_id: 'pot', portions: 1 }] }],
})

const item = (over) => ({
  name: 'x', local_name: null, food_id: null, recipe_id: null, saved_meal_id: null, portions: null,
  grams: 0, grams_low: 0, grams_high: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
  hidden: false, confidence: 0.8, basis: '', ...over,
})
const answer = (over) => ({ intent: 'meal', meal_slot: null, items: [], totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, pantry: [], question: null, ...over })

describe('matchParsed', () => {
  it('prices a matched food from the foods table, whatever the model said', () => {
    const r = matchParsed(answer({ items: [item({ name: 'boiled eggs', food_id: 'egg', grams: 150, kcal: 999 })] }), lib)
    expect(r.items[0]).toMatchObject({ source: 'food', food_id: 'egg', grams: 150, kcal: 233, protein_g: 18.9, flagged: false })
    expect(r.items[0].estimates.claude_text.kcal).toBe(999)
  })

  it('matches by name or alias when the model gave no id, and ignores ids that do not exist', () => {
    const r = matchParsed(answer({ items: [item({ name: 'Oranges', grams: 260 }), item({ name: 'egg', food_id: 'made-up', grams: 50 })] }), lib)
    expect(r.items.map((i) => [i.source, i.food_id])).toEqual([['food', 'orange'], ['food', 'egg']])
  })

  it('logs a recipe by portions', () => {
    const r = matchParsed(answer({ items: [item({ name: 'beans from the pot', recipe_id: 'pot', portions: 1.5 })] }), lib)
    expect(r.items[0]).toMatchObject({ source: 'recipe', recipe_id: 'pot', portions: 1.5 })
    // (3400 + 477.36) / 5 = 775.47 a portion
    expect(r.items[0].kcal).toBe(Math.round(775.472 * 1.5))
  })

  it('expands a saved meal into its items', () => {
    const r = matchParsed(answer({ items: [item({ name: 'beans container', saved_meal_id: 'bc', portions: 1 })] }), lib)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ source: 'saved', recipe_id: 'pot', saved_meal_id: 'bc', name: 'Beans pot' })
    expect(r.saved_meal_id).toBe('bc')
  })

  it('keeps an unknown food with the model figures, clamped, and flags it', () => {
    const r = matchParsed(answer({ items: [item({ name: 'Mama put stew', grams: 120, kcal: 180, protein_g: 2.5, fat_g: 15, confidence: 0.4 })] }), lib)
    expect(r.items[0]).toMatchObject({ source: 'free', food_id: null, kcal: 180, flagged: true })
    expect(r.items[0].flag_reason).toMatch(/not in your foods/i)
  })

  it('flags a guessed amount even on a known food', () => {
    const r = matchParsed(answer({ items: [item({ name: 'eggs', food_id: 'egg', grams: 100, confidence: 0.3 })] }), lib)
    expect(r.items[0].flagged).toBe(true)
    expect(r.items[0].flag_reason).toMatch(/guess/)
  })

  it('puts flagged items first and totals what it kept', () => {
    const r = matchParsed(answer({ items: [item({ name: 'eggs', food_id: 'egg', grams: 100 }), item({ name: 'mystery', kcal: 100 })] }), lib)
    expect(r.items.map((i) => i.name)).toEqual(['mystery', 'Egg, boiled'])
    expect(r.totals.kcal).toBe(155 + 100)
  })

  it('caps the item count, drops nameless items and refuses junk', () => {
    const many = Array.from({ length: 50 }, (_, i) => item({ name: `thing ${i}`, kcal: 1 }))
    expect(matchParsed(answer({ items: many }), lib).items).toHaveLength(PARSE_LIMITS.items)
    expect(matchParsed(answer({ items: [item({ name: '  ' })] }), lib).items).toEqual([])
    expect(matchParsed(null, lib)).toMatchObject({ intent: 'unclear', items: [], pantry: [] })
  })

  it('keeps the slot only when it is a real one', () => {
    expect(matchParsed(answer({ meal_slot: 'lunch' }), lib).meal_slot).toBe('lunch')
    expect(matchParsed(answer({ meal_slot: 'brunch' }), lib).meal_slot).toBe(null)
  })
})

describe('pantryUpdates', () => {
  it('reads "bought 2 kg beans for 3,000"', () => {
    const r = pantryUpdates(answer({ intent: 'pantry', pantry: [{ action: 'bought', name: 'beans', food_id: null, quantity: 2, unit: 'kg', cost_naira: '3,000' }] }), lib)
    expect(r).toEqual([{ action: 'bought', name: 'beans', food_id: 'beans', quantity: 2, unit: 'kg', cost_naira: 3000 }])
  })

  it('reads "eggs finished"', () => {
    expect(pantryUpdates(answer({ pantry: [{ action: 'finished', name: 'eggs', food_id: 'egg', quantity: null, unit: null, cost_naira: null }] }), lib)).toEqual([
      { action: 'finished', name: 'eggs', food_id: 'egg', quantity: null, unit: null, cost_naira: null },
    ])
  })

  it('drops updates with no name or an action it does not know', () => {
    expect(pantryUpdates(answer({ pantry: [{ action: 'stole', name: 'eggs' }, { action: 'bought', name: '' }] }), lib)).toEqual([])
  })
})

describe('parseNaira', () => {
  it('reads the ways naira gets written', () => {
    expect(parseNaira(3000)).toBe(3000)
    expect(parseNaira('₦1,500')).toBe(1500)
    expect(parseNaira('1.5k')).toBe(1500)
    expect(parseNaira('N 2k')).toBe(2000)
    expect(parseNaira('free')).toBe(null)
    expect(parseNaira(-5)).toBe(null)
  })
})

describe('scaleItem', () => {
  it('re-prices a food at new grams', () => {
    const egg = matchParsed(answer({ items: [item({ name: 'eggs', food_id: 'egg', grams: 100 })] }), lib).items[0]
    expect(scaleItem(egg, 150, lib)).toMatchObject({ grams: 150, kcal: 233 })
  })

  it('turns grams into portions for a recipe', () => {
    const pot = matchParsed(answer({ items: [item({ name: 'pot', recipe_id: 'pot', portions: 1 })] }), lib).items[0]
    const two = scaleItem(pot, pot.grams * 2, lib)
    expect(two.portions).toBe(2)
    expect(two.kcal).toBe(Math.round(775.472 * 2))
  })

  it('scales a free item in proportion', () => {
    const free = matchParsed(answer({ items: [item({ name: 'stew', grams: 100, kcal: 150, protein_g: 2 })] }), lib).items[0]
    expect(scaleItem(free, 200, lib)).toMatchObject({ grams: 200, kcal: 300, protein_g: 4 })
  })
})
