// What every photo model must return: the JSON prompts/food-vision.md
// defines, as a zod schema. Claude is held to it with structured outputs
// (zodOutputFormat); NVIDIA's answer and the laptop worker's (already
// checked with pydantic there) are validated against it here before they
// are stored or merged. Every field is required, nullable where the prompt
// allows null, numbers bounded.
//
// Added for the Diet module, Phase 3 (docs/diet-module.md).
import { z } from 'zod'

const num = z.number().min(0).max(100000)

export const VisionItem = z.object({
  name: z.string().min(1).max(120),
  local_name: z.string().max(120).nullable(),
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

export const FoodVision = z.object({
  items: z.array(VisionItem).max(30),
  totals: z.object({ kcal: num, protein_g: num, carbs_g: num, fat_g: num }),
  image_quality: z.enum(['good', 'partial', 'poor', 'no_food']),
  question: z.string().max(300).nullable(),
})

export type FoodVisionT = z.infer<typeof FoodVision>
