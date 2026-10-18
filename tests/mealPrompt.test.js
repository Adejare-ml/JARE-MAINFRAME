import { describe, it, expect } from 'vitest'
import {
  MEAL_SYSTEM_PROMPT,
  RESPONSE_SHAPE,
  NIGERIAN_ANCHORS,
  GENERAL_ANCHORS,
  MEAL_TYPES,
  MAX_HINT_CHARS,
  MAX_TEXT_CHARS,
  buildMealPrompt,
} from '../src/lib/mealPrompt.js'

describe('the anchor table', () => {
  it('has a serving and a sane calorie figure for every dish', () => {
    for (const row of [...NIGERIAN_ANCHORS, ...GENERAL_ANCHORS]) {
      expect(row).toHaveLength(3)
      const [dish, serving, kcal] = row
      expect(dish.length).toBeGreaterThan(2)
      expect(serving.length).toBeGreaterThan(2)
      expect(Number.isInteger(kcal)).toBe(true)
      expect(kcal).toBeGreaterThanOrEqual(0)
      expect(kcal).toBeLessThanOrEqual(800)
    }
  })

  it('names the staples a Lagos plate is made of', () => {
    const names = NIGERIAN_ANCHORS.map(([d]) => d.toLowerCase())
    for (const staple of ['jollof', 'eba', 'amala', 'pounded yam', 'egusi', 'efo riro', 'moi moi', 'akara', 'suya', 'plantain', 'indomie', 'agege bread', 'zobo']) {
      expect(names.some((n) => n.includes(staple))).toBe(true)
    }
  })

  it('has no duplicate dish names', () => {
    const names = NIGERIAN_ANCHORS.map(([d]) => d.toLowerCase())
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('MEAL_SYSTEM_PROMPT', () => {
  it('demands JSON only and embeds the response shape and every anchor', () => {
    expect(MEAL_SYSTEM_PROMPT).toMatch(/Return ONLY a JSON object/)
    expect(MEAL_SYSTEM_PROMPT).toContain(RESPONSE_SHAPE)
    for (const [dish, , kcal] of NIGERIAN_ANCHORS) {
      expect(MEAL_SYSTEM_PROMPT).toContain(`- ${dish}:`)
      expect(MEAL_SYSTEM_PROMPT).toContain(`= ${kcal} kcal`)
    }
  })

  it('tells the model what to do about bad light, clutter and no food', () => {
    expect(MEAL_SYSTEM_PROMPT).toMatch(/Identify by shape, texture, context/)
    expect(MEAL_SYSTEM_PROMPT).toMatch(/Never answer that you cannot see/)
    expect(MEAL_SYSTEM_PROMPT).toMatch(/laptops, keyboards, phones, cutlery/)
    expect(MEAL_SYSTEM_PROMPT).toMatch(/"is_food": false/)
    expect(MEAL_SYSTEM_PROMPT).toMatch(/never return a single item above 3000 kcal/)
  })

  it('names the meal types the app knows', () => {
    for (const t of MEAL_TYPES) expect(RESPONSE_SHAPE).toContain(`"${t}"`)
    expect(MEAL_TYPES).toEqual(['breakfast', 'lunch', 'dinner', 'snack'])
  })
})

describe('buildMealPrompt', () => {
  it('describes a photo, its measured quality and the correction applied', () => {
    const p = buildMealPrompt({
      quality: { note: 'Dark photo, brightened before sending; warm (yellow) light', corrected: true },
      hint: 'the soup is ogbono',
      localTime: '13:05',
      mealType: 'lunch',
    })
    expect(p).toMatch(/^Here is a photo/)
    expect(p).toContain('Dark photo, brightened before sending; warm (yellow) light')
    expect(p).toMatch(/Brightness and contrast were adjusted on the phone/)
    expect(p).toContain('"the soup is ogbono"')
    expect(p).toContain('Local time is 13:05.')
    expect(p).toContain('logging this as lunch')
    expect(p.trim().endsWith('Answer with the JSON object only.')).toBe(true)
  })

  it('says nothing about quality or correction for a clean photo with no report', () => {
    const p = buildMealPrompt({})
    expect(p).not.toMatch(/Photo quality/)
    expect(p).not.toMatch(/adjusted/)
    expect(p).not.toMatch(/Local time/)
  })

  it('builds the text-only path around the description', () => {
    const p = buildMealPrompt({ hasImage: false, text: 'Two wraps of eba with egusi and three pieces of beef' })
    expect(p).toMatch(/^There is no photo/)
    expect(p).toContain('"Two wraps of eba with egusi and three pieces of beef"')
    expect(p).not.toMatch(/Photo quality/)
  })

  it('caps and flattens the free text and ignores an unknown meal type', () => {
    const p = buildMealPrompt({ hasImage: false, text: 'a\n\n b '.repeat(400), hint: 'h'.repeat(500), mealType: 'brunch' })
    const quoted = p.match(/"([^"]*)"/g)
    expect(quoted[0].length - 2).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(quoted[1].length - 2).toBe(MAX_HINT_CHARS)
    expect(p).not.toContain('\n\n')
    expect(p).not.toMatch(/logging this as/)
  })
})
