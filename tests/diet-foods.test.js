import { describe, it, expect } from 'vitest'
import { normaliseName, searchFoods, portionOptions } from '../src/lib/diet/foods.js'

// Finding a food fast: the picker on the Today screen, and in Phase 2 and 3
// the match between what a model names and a row in the foods table.

const foods = [
  { id: 'f1', name: 'Fried plantain', aliases: ['dodo'], typical_portion_g: 150, portion_label: '10 slices' },
  { id: 'f2', name: 'Plantain, boiled', aliases: ['boiled plantain'], typical_portion_g: 180, portion_label: '1 medium finger' },
  { id: 'f3', name: 'Jollof rice', aliases: [], typical_portion_g: 300, portion_label: '1 takeaway pack' },
  { id: 'f4', name: 'Egg, boiled', aliases: ['eggs', 'boiled egg'], typical_portion_g: 50, portion_label: '1 egg' },
]
const recipes = [{ id: 'r1', name: 'Beans pot', portions: 5 }]

describe('normaliseName', () => {
  it('lowercases, drops punctuation and accents, and squeezes spaces', () => {
    expect(normaliseName('  Jollof   Rice! ')).toBe('jollof rice')
    expect(normaliseName('Égusi soup')).toBe('egusi soup')
    expect(normaliseName('Plantain, boiled')).toBe('plantain boiled')
  })
})

describe('searchFoods', () => {
  it('finds a food by its Nigerian name', () => {
    expect(searchFoods('dodo', foods, recipes)[0]).toMatchObject({ kind: 'food', id: 'f1' })
  })

  it('ranks an exact name, then a prefix, then a word inside', () => {
    const ids = searchFoods('plantain', foods, recipes).map((r) => r.id)
    expect(ids).toEqual(['f2', 'f1'])
  })

  it('includes recipes', () => {
    expect(searchFoods('beans', foods, recipes)).toEqual([expect.objectContaining({ kind: 'recipe', id: 'r1', name: 'Beans pot' })])
  })

  // Recipes first: a batch-cooked pot is the most common thing logged.
  it('lists everything, recipes first, for an empty query', () => {
    const r = searchFoods('', foods, recipes)
    expect(r).toHaveLength(5)
    expect(r[0].kind).toBe('recipe')
  })

  it('caps the list', () => {
    expect(searchFoods('', foods, recipes, 2)).toHaveLength(2)
  })
})

describe('portionOptions', () => {
  it('offers the typical portion, half, double and 100 g', () => {
    expect(portionOptions(foods[3])).toEqual([
      { label: '½ × 1 egg', grams: 25 },
      { label: '1 egg', grams: 50 },
      { label: '2 × 1 egg', grams: 100 },
      { label: '3 × 1 egg', grams: 150 },
      { label: '100 g', grams: 100 },
    ])
  })

  it('offers 100 g alone when no typical portion is known', () => {
    expect(portionOptions({ name: 'Mystery' })).toEqual([{ label: '100 g', grams: 100 }])
  })
})
