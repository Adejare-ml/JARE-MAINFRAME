/**
 * The food-vision answer (prompts/food-vision.md) as plain JSON Schema, for
 * the Node scripts that call the photo models from GitHub Actions: Ollama's
 * `format` (constrained decoding) and Claude's structured outputs in the
 * image test. Same fields as the zod schema in
 * supabase/functions/diet-photo/schema.ts, without the numeric bounds that
 * structured outputs do not accept; the edge function still checks every
 * stored answer against the zod schema, bounds included.
 *
 * checkVision is a light shape check for the scripts' own retry decision.
 *
 * Added after Phase 4, for the Ollama Cloud estimate job and the image test.
 */
const number = { type: 'number' }

export const FOOD_VISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'totals', 'image_quality', 'question'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'local_name', 'grams', 'grams_low', 'grams_high', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'hidden', 'confidence', 'basis'],
        properties: {
          name: { type: 'string' },
          local_name: { type: ['string', 'null'] },
          grams: number,
          grams_low: number,
          grams_high: number,
          kcal: number,
          protein_g: number,
          carbs_g: number,
          fat_g: number,
          hidden: { type: 'boolean' },
          confidence: number,
          basis: { type: 'string' },
        },
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      required: ['kcal', 'protein_g', 'carbs_g', 'fat_g'],
      properties: { kcal: number, protein_g: number, carbs_g: number, fat_g: number },
    },
    image_quality: { type: 'string', enum: ['good', 'partial', 'poor', 'no_food'] },
    question: { type: ['string', 'null'] },
  },
}

const ITEM_NUMBERS = ['grams', 'grams_low', 'grams_high', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence']

/** Parse a model's text and check it has the answer's shape. Returns {ok, answer} or {ok:false, reason}. */
export function checkVision(text) {
  let answer
  try {
    answer = typeof text === 'string' ? JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) : text
  } catch (err) {
    return { ok: false, reason: `not JSON (${String(err.message).slice(0, 80)})` }
  }
  if (!answer || !Array.isArray(answer.items)) return { ok: false, reason: 'no items list' }
  for (const [i, it] of answer.items.entries()) {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) return { ok: false, reason: `item ${i + 1} has no name` }
    for (const k of ITEM_NUMBERS) if (typeof it[k] !== 'number' || !Number.isFinite(it[k]) || it[k] < 0) return { ok: false, reason: `item ${i + 1}: ${k} is not a number` }
  }
  if (!answer.totals || typeof answer.totals.kcal !== 'number') return { ok: false, reason: 'no totals' }
  if (!['good', 'partial', 'poor', 'no_food'].includes(answer.image_quality)) return { ok: false, reason: 'bad image_quality' }
  return { ok: true, answer }
}
