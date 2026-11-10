import { describe, it, expect } from 'vitest'
import { coachInput, patternFlag, checkCoachAnswer, needsCoach, plainText } from '../src/lib/diet/coach.js'

// The coach (prompts/coach.md, Phase 4): what it is sent, the patterns it
// is asked to flag, and the checks its answer passes before it is shown.

const settings = { kcal_target: 2300, protein_target_g: 100, meal_split: { breakfast: 0.2, lunch: 0.35, dinner: 0.3, snacks: 0.15 }, avoid_foods: ['onions'] }

describe('needsCoach', () => {
  it('asks the coach only for meals whose numbers came from a model', () => {
    expect(needsCoach({ source: 'text' })).toBe(true)
    expect(needsCoach({ source: 'voice' })).toBe(true)
    expect(needsCoach({ source: 'photo' })).toBe(true)
    // Saved and hand-picked meals have known numbers: the verdict is computed in code.
    expect(needsCoach({ source: 'saved' })).toBe(false)
    expect(needsCoach({ source: 'manual' })).toBe(false)
  })
})

describe('coachInput', () => {
  const todayLogs = [
    { id: 'm1', eaten_at: '2026-11-10T06:45:00Z', meal_slot: 'breakfast', kcal: 442, protein_g: 20.3, meal_items: [{ name: 'Egg, boiled' }, { name: 'Plantain, boiled' }] },
    { id: 'm2', eaten_at: '2026-11-10T12:30:00Z', meal_slot: 'lunch', kcal: 803, protein_g: 45.9, meal_items: [{ name: 'Beans pot' }] },
  ]
  const recent = [
    { eaten_on: '2026-11-09', kcal: 2410, protein_g: 88 },
    { eaten_on: '2026-11-08', kcal: 2150, protein_g: 102 },
  ]
  const pantry = [
    { name: 'eggs', quantity: 27, unit: 'eggs', finished: false },
    { name: 'garri', quantity: null, unit: null, finished: true },
  ]

  it('sends the prompt\'s six inputs, the meal split out of today', () => {
    const input = coachInput({ settings, todayLogs, recent, mealId: 'm2', localTime: '13:40', pantry })
    expect(Object.keys(input)).toEqual(['settings', 'today', 'recent', 'meal', 'time', 'pantry'])
    expect(input.settings).toEqual({ kcal_target: 2300, protein_target_g: 100, meal_split: settings.meal_split })
    expect(input.meal).toEqual({ slot: 'lunch', time: '13:30', kcal: 803, protein_g: 45.9, items: ['Beans pot'] })
    expect(input.today.meals).toHaveLength(1)
    expect(input.today.totals).toMatchObject({ kcal: 442, protein_g: 20.3, kcal_left_before_this_meal: 1858 })
    expect(input.recent).toEqual([
      { date: '2026-11-08', kcal: 2150, protein_g: 102 },
      { date: '2026-11-09', kcal: 2410, protein_g: 88 },
    ])
    expect(input.time).toBe('13:40')
    expect(input.pantry).toEqual([{ name: 'eggs', quantity: 27, unit: 'eggs' }])
  })

  it('has meal null for "what should I eat next", with all of today in today', () => {
    const input = coachInput({ settings, todayLogs, recent, mealId: null, localTime: '16:00', pantry })
    expect(input.meal).toBe(null)
    expect(input.today.meals).toHaveLength(2)
    expect(input.today.totals).toMatchObject({ kcal: 1245, kcal_left: 1055, protein_left: 33.8 })
  })
})

describe('patternFlag', () => {
  const day = (d, kcal, protein_g) => ({ eaten_on: `2026-11-${String(d).padStart(2, '0')}`, kcal, protein_g })

  it('flags three days running over target', () => {
    expect(patternFlag([day(7, 2500, 110), day(8, 2400, 110), day(9, 2600, 110)], settings)).toBe('Three days in a row over target.')
  })

  it('flags protein under 70 g three days running', () => {
    expect(patternFlag([day(7, 2000, 60), day(8, 2000, 65), day(9, 2000, 50)], settings)).toBe('Protein under 70 g for three days running.')
  })

  it('needs the three days to be consecutive and the latest ones', () => {
    expect(patternFlag([day(5, 2500, 110), day(6, 2500, 110), day(8, 2500, 110)], settings)).toBe(null)
    expect(patternFlag([day(6, 2500, 110), day(7, 2500, 110), day(8, 2500, 110), day(9, 2000, 110)], settings)).toBe(null)
  })

  it('is null with no target or too little history', () => {
    expect(patternFlag([day(8, 2500, 110), day(9, 2500, 110)], settings)).toBe(null)
    expect(patternFlag([day(7, 2500, 110), day(8, 2500, 110), day(9, 2500, 110)], {})).toBe(null)
  })
})

describe('plainText', () => {
  it('takes out em and en dashes, the coach prompt bans them', () => {
    expect(plainText('800 kcal — that leaves 1,060 – fine')).toBe('800 kcal, that leaves 1,060, fine')
  })
})

describe('checkCoachAnswer', () => {
  const code = { verdict: 'fits', reason: '803 kcal and 46 g protein. Leaves you 1,055 kcal for the rest of the day.' }
  const option = (meal, kcal = 500, extra = {}) => ({ meal, kcal, protein_g: 25, from_pantry: true, why: 'fits', ...extra })

  it('keeps the coach\'s reason when its verdict agrees with the rules', () => {
    const r = checkCoachAnswer({ verdict: 'fits', reason: 'Solid lunch. 1,055 kcal left.', next_options: [], flag: null }, { hasMeal: true, code, settings })
    expect(r).toMatchObject({ verdict: 'fits', reason: 'Solid lunch. 1,055 kcal left.', agreed: true })
  })

  it('keeps the rule-based verdict and reason when the coach disagrees', () => {
    const r = checkCoachAnswer({ verdict: 'over', reason: 'Too much.', next_options: [], flag: null }, { hasMeal: true, code, settings })
    expect(r).toMatchObject({ verdict: 'fits', reason: code.reason, agreed: false })
  })

  it('has no verdict for "what next"', () => {
    expect(checkCoachAnswer({ verdict: 'fits', reason: 'x', next_options: [option('Eggs')], flag: null }, { hasMeal: false, code: null, settings }).verdict).toBe(null)
  })

  it('drops options with a food the owner avoids, or that skip a meal, or go negative', () => {
    const r = checkCoachAnswer(
      {
        verdict: null,
        reason: 'x',
        next_options: [option('Egg stew with onions and tomato'), option('Skip dinner tonight', 0), option('3 eggs with cabbage and carrots', 520), option('Odd', -5), option('Suya, lean pieces, no bread', 400)],
        flag: null,
      },
      { hasMeal: false, code: null, settings },
    )
    expect(r.next_options.map((o) => o.meal)).toEqual(['3 eggs with cabbage and carrots', 'Suya, lean pieces, no bread'])
  })

  it('keeps at most three options, pantry ones first', () => {
    const r = checkCoachAnswer(
      { verdict: null, reason: 'x', next_options: [option('A', 400, { from_pantry: false }), option('B'), option('C'), option('D')], flag: null },
      { hasMeal: false, code: null, settings },
    )
    expect(r.next_options.map((o) => o.meal)).toEqual(['B', 'C', 'D'])
  })

  it('cleans dashes out of every line it shows', () => {
    const r = checkCoachAnswer({ verdict: 'fits', reason: 'Fine — 1,055 left.', next_options: [option('Eggs — boiled')], flag: 'Watch it — again' }, { hasMeal: true, code, settings })
    expect(r.reason).toBe('Fine, 1,055 left.')
    expect(r.next_options[0].meal).toBe('Eggs, boiled')
    expect(r.flag).toBe('Watch it, again')
  })
})
