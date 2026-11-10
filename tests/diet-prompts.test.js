import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildPromptModule } from '../scripts/build-diet-prompts.mjs'
import { FOOD_VISION_MD, COACH_MD, TEXT_PARSE_MD } from '../src/lib/diet/promptText.js'
import { promptBody, promptValues, fillPrompt, catalogText, parseUserMessage } from '../src/lib/diet/prompts.js'
import { buildLibrary } from '../src/lib/diet/library.js'

// The prompts live in prompts/*.md (reviewed as text) and are copied into
// src/lib/diet/promptText.js for the edge functions (Diet module, Phase 2).

describe('prompt copies', () => {
  it('promptText.js is exactly what the build script makes from prompts/*.md', () => {
    const onDisk = readFileSync(new URL('../src/lib/diet/promptText.js', import.meta.url), 'utf8')
    expect(onDisk, 'run: node scripts/build-diet-prompts.mjs').toBe(buildPromptModule())
  })

  it('holds each Markdown file word for word', () => {
    const md = (n) => readFileSync(new URL(`../prompts/${n}.md`, import.meta.url), 'utf8')
    expect(FOOD_VISION_MD).toBe(md('food-vision'))
    expect(COACH_MD).toBe(md('coach'))
    expect(TEXT_PARSE_MD).toBe(md('text-parse'))
  })

  it('carries no personal detail: the owner is only ever a placeholder', () => {
    for (const md of [FOOD_VISION_MD, COACH_MD, TEXT_PARSE_MD]) {
      expect(md).not.toMatch(/Daniel|Abuja|onion/i)
      expect(md).toMatch(/\{\{food_rules\}\}/)
    }
  })
})

describe('promptBody', () => {
  it('drops the header above the first rule', () => {
    expect(promptBody('# Title\n\nAbout it.\n\n---\n\nYou do X.\n')).toBe('You do X.')
    expect(promptBody(TEXT_PARSE_MD)).toMatch(/^You turn one short note/)
  })
})

describe('fillPrompt', () => {
  const settings = { display_name: 'Ade', city: 'Lokoja', sex: 'male', avoid_foods: ['onions', 'okra'], substitutes: 'cabbage and carrots' }

  it('fills the owner details from settings and leaves no placeholder', () => {
    const text = fillPrompt(COACH_MD, settings)
    expect(text).toMatch(/inside Ade's Jare Mainframe app/)
    expect(text).toMatch(/He doesn't eat onions or okra\. Use cabbage and carrots instead\./)
    expect(text).not.toMatch(/\{\{/)
    expect(fillPrompt(TEXT_PARSE_MD, settings)).toMatch(/lives in Lokoja, Nigeria,/)
  })

  it('reads sensibly with nothing set', () => {
    const text = fillPrompt(TEXT_PARSE_MD, null)
    expect(text).toMatch(/lives in Nigeria,/)
    expect(text).toMatch(/No foods are ruled out\./)
    expect(text).not.toMatch(/\{\{/)
    expect(fillPrompt(COACH_MD, {})).toMatch(/inside the owner's Jare Mainframe app/)
  })

  it('refuses a template with a placeholder it does not know', () => {
    expect(() => fillPrompt('---\nHi {{shoe_size}}')).toThrow(/shoe_size/)
  })

  it('values come from settings only', () => {
    expect(promptValues({ city: '  ' }).location).toBe('Nigeria')
  })
})

describe('catalogText', () => {
  const lib = buildLibrary({
    foods: [
      { id: 'f1', name: 'Egg, boiled', aliases: ['eggs'], kcal_per_100g: 155, typical_portion_g: 50, portion_label: '1 egg' },
      { id: 'f2', name: 'Palm oil', aliases: [], kcal_per_100g: 884 },
    ],
    recipes: [{ id: 'r1', name: 'Beans pot', portions: 5 }],
    ingredients: [{ recipe_id: 'r1', food_id: 'f2', grams: 50 }],
    saved: [{ id: 's1', name: 'Beans container', items: [{ recipe_id: 'r1', portions: 1 }] }],
  })

  it('lists foods, recipes and saved meals one per line, ids first', () => {
    const text = catalogText(lib)
    expect(text).toContain('f1 | Egg, boiled | eggs | 155 kcal/100 g | 1 egg = 50 g')
    expect(text).toContain('f2 | Palm oil |  | 884 kcal/100 g |')
    expect(text).toContain('r1 | Beans pot | 1 portion = 10 g, 88 kcal')
    expect(text).toContain('s1 | Beans container | 1 portion Beans pot')
  })

  it('is the same text for the same library, so the prompt cache can hit', () => {
    expect(catalogText(lib)).toBe(catalogText(lib))
  })
})

describe('parseUserMessage', () => {
  it('puts the time and the note in, the note fenced and trimmed', () => {
    const m = parseUserMessage({ text: '  2 boiled eggs  ', localTime: '07:40' })
    expect(m).toContain('Local time: 07:40')
    expect(m).toContain('<note>\n2 boiled eggs\n</note>')
  })
})
