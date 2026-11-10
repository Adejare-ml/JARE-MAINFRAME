// The JSON the text parser must return (prompts/text-parse.md), as a zod
// schema. It does two jobs: zodOutputFormat turns it into the structured
// output format sent with the request, so the model is held to this shape,
// and the SDK validates the answer against it on the way back. Items use the
// same fields as the photo prompt (prompts/food-vision.md) plus the catalogue
// ids, so text, voice and photo meals reach one review screen.
//
// Every field is required and nullable rather than optional: structured
// outputs need every property listed. Numeric bounds are checked here, in
// zod; the SDK drops the ones the API cannot enforce from the schema it
// sends and checks them on the way back.
//
// Added for the Diet module, Phase 2 (docs/diet-module.md).
import { z } from 'zod'

const num = z.number().min(0).max(100000)

export const ParsedItem = z.object({
  name: z.string().max(120),
  local_name: z.string().max(120).nullable(),
  food_id: z.string().max(64).nullable(),
  recipe_id: z.string().max(64).nullable(),
  saved_meal_id: z.string().max(64).nullable(),
  portions: z.number().min(0).max(20).nullable(),
  grams: num,
  grams_low: num,
  grams_high: num,
  kcal: num,
  protein_g: num,
  carbs_g: num,
  fat_g: num,
  hidden: z.boolean(),
  confidence: z.number().min(0).max(1),
  basis: z.string().max(300),
})

export const PantryUpdate = z.object({
  action: z.enum(['bought', 'finished', 'used']),
  name: z.string().max(80),
  food_id: z.string().max(64).nullable(),
  quantity: z.number().min(0).max(100000).nullable(),
  unit: z.string().max(20).nullable(),
  cost_naira: z.number().min(0).max(100000000).nullable(),
})

export const ParseResult = z.object({
  intent: z.enum(['meal', 'pantry', 'both', 'unclear']),
  meal_slot: z.enum(['breakfast', 'lunch', 'dinner', 'snacks']).nullable(),
  items: z.array(ParsedItem).max(30),
  totals: z.object({ kcal: num, protein_g: num, carbs_g: num, fat_g: num }),
  pantry: z.array(PantryUpdate).max(20),
  question: z.string().max(300).nullable(),
})

export type ParseResultT = z.infer<typeof ParseResult>
