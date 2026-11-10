import { describe, it, expect } from 'vitest'
import { mergeEstimates, itemKey, median, attachEstimates, MODEL_LABELS } from '../src/lib/diet/merge.js'
import { buildLibrary } from '../src/lib/diet/library.js'

// The three-model photo merge (docs/diet-module.md, Phase 3), from the
// build spec: match items across models by normalised name and against the
// foods table; take the median grams; recompute kcal and macros from the
// foods table when an item matches, otherwise the median of the models'
// figures; flag an item when the models disagree on grams by more than 25%
// or only one model sees it.

const lib = buildLibrary({
  foods: [
    { id: 'rice', name: 'White rice, boiled', aliases: ['rice', 'white rice', 'boiled rice'], kcal_per_100g: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3 },
    { id: 'stew', name: 'Tomato stew', aliases: ['stew', 'red stew'], kcal_per_100g: 140, protein_g: 1.5, carbs_g: 7, fat_g: 12 },
    { id: 'dodo', name: 'Fried plantain', aliases: ['dodo', 'fried plantains'], kcal_per_100g: 260, protein_g: 1.5, carbs_g: 40, fat_g: 11 },
  ],
})

const it_ = (o) => ({ name: 'x', local_name: null, grams: 0, grams_low: 0, grams_high: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, hidden: false, confidence: 0.8, basis: '', ...o })
const answer = (items, extra = {}) => ({ items, totals: { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, image_quality: 'good', question: null, ...extra })

describe('median', () => {
  it('is the middle value, or the mean of the two middle values', () => {
    expect(median([300, 200, 250])).toBe(250)
    expect(median([200, 300])).toBe(250)
    expect(median([7])).toBe(7)
    expect(median([])).toBe(null)
  })
})

describe('itemKey', () => {
  it('is the food when the name or an alias matches the foods table', () => {
    expect(itemKey({ name: 'rice' }, lib)).toBe('food:rice')
    expect(itemKey({ name: 'Boiled rice' }, lib)).toBe('food:rice')
    expect(itemKey({ name: 'plantain', local_name: 'dodo' }, lib)).toBe('food:dodo')
  })

  it('is the words of the name otherwise, in any order, plurals folded', () => {
    expect(itemKey({ name: 'Grilled chicken thigh' }, lib)).toBe(itemKey({ name: 'chicken thighs, grilled' }, lib))
    expect(itemKey({ name: 'a piece of beef' }, lib)).toBe(itemKey({ name: 'Beef' }, lib))
  })
})

describe('mergeEstimates', () => {
  const three = [
    { model: 'claude', answer: answer([it_({ name: 'white rice', grams: 250, kcal: 325 }), it_({ name: 'stew', grams: 100, kcal: 150, hidden: false })]) },
    { model: 'nvidia', answer: answer([it_({ name: 'rice', grams: 300, kcal: 390 }), it_({ name: 'red stew', grams: 80, kcal: 110 })]) },
    { model: 'ollama', answer: answer([it_({ name: 'jollof?', grams: 0 }), it_({ name: 'Boiled rice', grams: 200, kcal: 260 }), it_({ name: 'tomato stew', grams: 90, kcal: 126 })]) },
  ]

  it('takes the median grams and prices a matched food from the foods table', () => {
    const m = mergeEstimates(three, lib)
    const rice = m.items.find((i) => i.food_id === 'rice')
    expect(rice.grams).toBe(250)
    expect(rice.kcal).toBe(325)
    expect(rice.protein_g).toBe(6.8)
    expect(rice.models).toEqual(['claude', 'nvidia', 'ollama'])
  })

  it('keeps each model\'s raw estimate beside the final numbers', () => {
    const rice = mergeEstimates(three, lib).items.find((i) => i.food_id === 'rice')
    expect(rice.estimates.claude.grams).toBe(250)
    expect(rice.estimates.nvidia.grams).toBe(300)
    expect(rice.estimates.ollama.name).toBe('Boiled rice')
  })

  it('flags an item only one model saw', () => {
    const odd = mergeEstimates(three, lib).items.find((i) => i.name === 'jollof?')
    expect(odd.flagged).toBe(true)
    expect(odd.flag_reason).toBe(`Only ${MODEL_LABELS.ollama} saw this`)
  })

  it('flags a disagreement on grams of more than 25%, and not one of 25% or less', () => {
    const wide = mergeEstimates(
      [
        { model: 'claude', answer: answer([it_({ name: 'rice', grams: 200 })]) },
        { model: 'nvidia', answer: answer([it_({ name: 'rice', grams: 251 })]) },
      ],
      lib,
    ).items[0]
    expect(wide.flagged).toBe(true)
    expect(wide.flag_reason).toBe('The models disagree on the amount: 200 to 251 g')
    const close = mergeEstimates(
      [
        { model: 'claude', answer: answer([it_({ name: 'rice', grams: 200 })]) },
        { model: 'nvidia', answer: answer([it_({ name: 'rice', grams: 250 })]) },
      ],
      lib,
    ).items[0]
    expect(close.flagged).toBe(false)
    expect(close.grams).toBe(225)
  })

  it('uses the median of the models\' figures for a food not in the table', () => {
    const m = mergeEstimates(
      [
        { model: 'claude', answer: answer([it_({ name: 'chicken thigh, grilled', grams: 120, kcal: 250, protein_g: 30 })]) },
        { model: 'nvidia', answer: answer([it_({ name: 'grilled chicken thighs', grams: 130, kcal: 280, protein_g: 32 })]) },
        { model: 'ollama', answer: answer([it_({ name: 'Chicken thigh grilled', grams: 110, kcal: 200, protein_g: 26 })]) },
      ],
      lib,
    )
    expect(m.items).toHaveLength(1)
    expect(m.items[0]).toMatchObject({ food_id: null, grams: 120, kcal: 250, protein_g: 30, flagged: false })
  })

  it('adds up two entries of the same thing from one model before comparing', () => {
    const m = mergeEstimates(
      [
        { model: 'claude', answer: answer([it_({ name: 'dodo', grams: 60 }), it_({ name: 'fried plantain', grams: 60 })]) },
        { model: 'nvidia', answer: answer([it_({ name: 'dodo', grams: 120 })]) },
      ],
      lib,
    )
    expect(m.items[0]).toMatchObject({ food_id: 'dodo', grams: 120, flagged: false })
  })

  it('with only one model answering, keeps its items unflagged and says so once', () => {
    const m = mergeEstimates([{ model: 'claude', answer: answer([it_({ name: 'rice', grams: 250 }), it_({ name: 'egg', grams: 50, kcal: 78 })]) }], lib)
    expect(m.models_answered).toEqual(['claude'])
    expect(m.single_model).toBe(true)
    expect(m.items.every((i) => !i.flagged)).toBe(true)
  })

  it('still flags a guessed amount', () => {
    const m = mergeEstimates([{ model: 'claude', answer: answer([it_({ name: 'rice', grams: 250, confidence: 0.3 })]) }], lib)
    expect(m.items[0].flag_reason).toMatch(/guess/)
  })

  it('marks an item hidden when most models that saw it say hidden', () => {
    const m = mergeEstimates(
      [
        { model: 'claude', answer: answer([it_({ name: 'palm oil', grams: 15, kcal: 133, hidden: true })]) },
        { model: 'nvidia', answer: answer([it_({ name: 'palm oil', grams: 12, kcal: 106, hidden: true })]) },
        { model: 'ollama', answer: answer([it_({ name: 'palm oil', grams: 14, kcal: 124, hidden: false })]) },
      ],
      lib,
    )
    expect(m.items[0].hidden).toBe(true)
  })

  it('totals what it kept, puts flagged items first, and carries the questions and photo quality', () => {
    const m = mergeEstimates(
      [
        { model: 'claude', answer: answer([it_({ name: 'rice', grams: 250 })], { question: 'Is there meat under the rice?', image_quality: 'partial' }) },
        { model: 'nvidia', answer: answer([it_({ name: 'rice', grams: 260 }), it_({ name: 'coke', grams: 350, kcal: 147 })]) },
      ],
      lib,
    )
    expect(m.items[0].name).toBe('coke')
    expect(m.totals.kcal).toBe(m.items.reduce((a, i) => a + i.kcal, 0))
    expect(m.questions).toEqual(['Is there meat under the rice?'])
    expect(m.image_quality).toBe('partial')
  })

  it('reads "no food" when every model that answered saw none', () => {
    const m = mergeEstimates(
      [
        { model: 'claude', answer: answer([], { image_quality: 'no_food' }) },
        { model: 'nvidia', answer: answer([], { image_quality: 'no_food' }) },
      ],
      lib,
    )
    expect(m.no_food).toBe(true)
    expect(m.items).toEqual([])
  })

  it('ignores models that failed', () => {
    const m = mergeEstimates([{ model: 'claude', answer: null }, { model: 'nvidia', answer: answer([it_({ name: 'rice', grams: 250 })]) }], lib)
    expect(m.models_answered).toEqual(['nvidia'])
  })
})

describe('attachEstimates', () => {
  it('stores a late estimate beside a confirmed meal without touching its numbers', () => {
    const stored = [
      { id: 'i1', food_id: 'rice', name: 'White rice, boiled', grams: 250, kcal: 325, estimates: { claude: { grams: 250 } } },
      { id: 'i2', food_id: null, name: 'Grilled chicken thigh', grams: 120, kcal: 250, estimates: {} },
    ]
    const late = answer([it_({ name: 'rice', grams: 280 }), it_({ name: 'chicken thighs grilled', grams: 100 }), it_({ name: 'zobo', grams: 300 })])
    const updates = attachEstimates(stored, 'ollama', late, lib)
    expect(updates).toEqual([
      { id: 'i1', estimates: { claude: { grams: 250 }, ollama: expect.objectContaining({ grams: 280 }) } },
      { id: 'i2', estimates: { ollama: expect.objectContaining({ grams: 100 }) } },
    ])
  })
})

// Added after the first image test (10 Nov): Claude lists hidden oil as its
// own item, as prompts/food-vision.md asks, but the seeded foods are priced
// as served, oil included ("Includes typical cooking oil", "Deep fried").
// A jollof takeaway pack came out at about 1,000 kcal instead of about 750.
describe('mergeEstimates: oil already in a food priced as served', () => {
  const oily = buildLibrary({
    foods: [
      { id: 'jollof', name: 'Jollof rice', aliases: ['jollof'], kcal_per_100g: 165, protein_g: 3, carbs_g: 27, fat_g: 5, source: 'Estimate: ... Includes typical cooking oil.' },
      { id: 'rice', name: 'White rice, boiled', aliases: ['white rice'], kcal_per_100g: 130, protein_g: 2.7, carbs_g: 28.2, fat_g: 0.3, source: 'Estimate: ... Cooked, unsalted.' },
      { id: 'palm', name: 'Palm oil', aliases: ['red oil'], kcal_per_100g: 884, protein_g: 0, carbs_g: 0, fat_g: 100, source: 'Estimate: ... Pure oil.' },
    ],
  })
  const oil = (name, grams = 30) => it_({ name, grams, kcal: grams * 9, fat_g: grams, hidden: true })

  it('leaves out hidden oil when a dish in the meal is priced with its oil', () => {
    const m = mergeEstimates([{ model: 'claude', answer: answer([it_({ name: 'jollof rice', grams: 450, kcal: 600 }), oil('cooking oil in jollof (absorbed)')]) }], oily)
    expect(m.items.map((i) => i.name)).toEqual(['Jollof rice'])
    expect(m.totals.kcal).toBe(743)
    expect(m.absorbed).toEqual([{ name: 'cooking oil in jollof (absorbed)', kcal: 270, into: 'Jollof rice' }])
  })

  it('also when the oil matched the Palm oil food', () => {
    const m = mergeEstimates([{ model: 'claude', answer: answer([it_({ name: 'jollof', grams: 300 }), oil('palm oil', 20)]) }], oily)
    expect(m.items.map((i) => i.food_id)).toEqual(['jollof'])
  })

  it('keeps the oil when nothing in the meal already counts it', () => {
    const m = mergeEstimates([{ model: 'claude', answer: answer([it_({ name: 'white rice', grams: 250 }), oil('oil drizzled on rice', 10)]) }], oily)
    expect(m.items).toHaveLength(2)
    expect(m.absorbed).toEqual([])
  })

  it('keeps oil the models did not call hidden, such as a bottle of oil in the photo', () => {
    const m = mergeEstimates([{ model: 'claude', answer: answer([it_({ name: 'jollof rice', grams: 300 }), it_({ name: 'palm oil', grams: 15, kcal: 133, hidden: false })]) }], oily)
    expect(m.items).toHaveLength(2)
  })
})
