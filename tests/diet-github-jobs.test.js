import { describe, it, expect } from 'vitest'
import { checkVision, FOOD_VISION_JSON_SCHEMA } from '../src/lib/diet/visionSchema.js'
import { workerToken } from '../scripts/lib/workerToken.mjs'
import { readFileSync } from 'node:fs'

// The pieces the GitHub diet jobs share (check-in, Ollama Cloud, image test).
// Added after Phase 4.

const item = (over = {}) => ({ name: 'Jollof rice', local_name: null, grams: 300, grams_low: 250, grams_high: 350, kcal: 495, protein_g: 9, carbs_g: 81, fat_g: 15, hidden: false, confidence: 0.7, basis: 'one takeaway pack', ...over })
const answer = (items = [item()]) => ({ items, totals: { kcal: 495, protein_g: 9, carbs_g: 81, fat_g: 15 }, image_quality: 'good', question: null })

describe('checkVision', () => {
  it('accepts an answer of the right shape, as text or in a code fence', () => {
    expect(checkVision(JSON.stringify(answer())).ok).toBe(true)
    expect(checkVision('```json\n' + JSON.stringify(answer()) + '\n```').ok).toBe(true)
  })

  it('refuses text that is not JSON, a missing number and an unknown quality', () => {
    expect(checkVision('the plate has rice').ok).toBe(false)
    expect(checkVision(JSON.stringify(answer([item({ kcal: '495' })]))).reason).toMatch(/kcal/)
    expect(checkVision(JSON.stringify({ ...answer(), image_quality: 'great' })).ok).toBe(false)
  })

  it('matches the fields of the zod schema the edge function stores against', () => {
    const zod = readFileSync('supabase/functions/diet-photo/schema.ts', 'utf8')
    for (const key of FOOD_VISION_JSON_SCHEMA.properties.items.items.required) expect(zod).toContain(`${key}:`)
    for (const key of FOOD_VISION_JSON_SCHEMA.required) expect(zod).toContain(`${key}:`)
  })
})

describe('workerToken', () => {
  it('is a stable, one-way token from the service key', () => {
    const a = workerToken('service-key-one')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(workerToken('service-key-one')).toBe(a)
    expect(workerToken('service-key-two')).not.toBe(a)
    expect(a).not.toContain('service-key-one')
  })

  it('refuses to derive a token from nothing', () => {
    expect(() => workerToken('')).toThrow()
  })
})
