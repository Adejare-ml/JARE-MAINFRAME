import { describe, it, expect } from 'vitest'
import { recipeTotals, recipePortion, recipeItem } from '../src/lib/diet/recipes.js'

// Recipe portions (docs/diet-module.md, section 3). The fixture uses round
// per-100 g figures so the expected numbers can be checked by hand; the real
// values live in the foods seed (migration 049).

const foods = new Map([
  ['beans', { id: 'beans', name: 'Brown beans, dry', kcal_per_100g: 340, protein_g: 22, carbs_g: 55, fat_g: 1.5 }],
  ['palm', { id: 'palm', name: 'Palm oil', kcal_per_100g: 900, protein_g: 0, carbs_g: 0, fat_g: 100 }],
  ['carrot', { id: 'carrot', name: 'Carrot', kcal_per_100g: 40, protein_g: 1, carbs_g: 8, fat_g: 0.2 }],
  ['blend', { id: 'blend', name: 'Tomato and pepper blend', kcal_per_100g: 25, protein_g: 1, carbs_g: 5, fat_g: 0.3 }],
])

const beansPot = { id: 'r1', name: 'Beans pot', portions: 5, cooked_weight_g: null }
const ingredients = [
  { food_id: 'beans', grams: 1000 },
  { food_id: 'palm', grams: 54 },
  { food_id: 'carrot', grams: 150 },
  { food_id: 'blend', grams: 300 },
]

describe('recipeTotals', () => {
  it('sums every ingredient by weight', () => {
    const t = recipeTotals(ingredients, foods)
    // 3400 + 486 + 60 + 75
    expect(t.kcal).toBe(4021)
    // 220 + 0 + 1.5 + 3
    expect(t.protein_g).toBe(224.5)
    expect(t.grams).toBe(1504)
    expect(t.missing).toEqual([])
  })

  it('names an ingredient whose food is gone instead of counting it as zero silently', () => {
    const t = recipeTotals([...ingredients, { food_id: 'ghost', grams: 10 }], foods)
    expect(t.missing).toEqual(['ghost'])
    expect(t.kcal).toBe(4021)
  })
})

describe('recipePortion', () => {
  it('divides the pot by its portions', () => {
    const p = recipePortion(beansPot, ingredients, foods)
    expect(p.kcal).toBe(804)
    expect(p.protein_g).toBe(44.9)
    // No cooked weight recorded: a portion is a fifth of the raw ingredients.
    expect(p.grams).toBe(300.8)
  })

  it('uses the cooked weight for a portion when the pot was weighed', () => {
    const p = recipePortion({ ...beansPot, cooked_weight_g: 3000 }, ingredients, foods)
    expect(p.grams).toBe(600)
    expect(p.kcal).toBe(804)
  })

  it('changing the portions changes each portion, not the pot', () => {
    const six = recipePortion({ ...beansPot, portions: 6 }, ingredients, foods)
    expect(six.kcal).toBe(670)
    expect(recipeTotals(ingredients, foods).kcal).toBe(4021)
  })

  it('refuses a recipe with no portions', () => {
    expect(recipePortion({ ...beansPot, portions: 0 }, ingredients, foods)).toBe(null)
  })
})

describe('recipeItem', () => {
  it('logs portions of a recipe as one item', () => {
    const p = recipePortion(beansPot, ingredients, foods)
    expect(recipeItem(beansPot, p, 1.5)).toEqual({
      recipe_id: 'r1',
      food_id: null,
      name: 'Beans pot',
      portions: 1.5,
      grams: 451.2,
      kcal: 1206,
      protein_g: 67.4,
      carbs_g: 173.1,
      fat_g: 21.1,
    })
  })
})
