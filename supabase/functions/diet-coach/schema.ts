// What the coach must return (prompts/coach.md), as a zod schema: held to
// it with structured outputs, and checked again by src/lib/diet/coach.js
// (checkCoachAnswer) before anything is stored or shown.
//
// Added for the Diet module, Phase 4 (docs/diet-module.md).
import { z } from 'zod'

export const NextOption = z.object({
  meal: z.string().min(1).max(200),
  kcal: z.number().min(0).max(5000),
  protein_g: z.number().min(0).max(500),
  from_pantry: z.boolean(),
  why: z.string().max(200),
})

export const CoachAnswer = z.object({
  verdict: z.enum(['fits', 'tight', 'over']).nullable(),
  reason: z.string().max(400),
  next_options: z.array(NextOption).max(3),
  flag: z.string().max(200).nullable(),
})

export type CoachAnswerT = z.infer<typeof CoachAnswer>
