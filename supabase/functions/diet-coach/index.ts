// Deno, deployed as a Supabase Edge Function: `supabase functions deploy diet-coach`.
//
// The coach for the Diet module (Phase 4, docs/diet-module.md): a verdict
// and a one-line reason after a meal logged from a note, a voice note or a
// photo, and "What should I eat next?". All the logic is in ./handler.ts.
//
// Secrets: ANTHROPIC_API_KEY (already set for diet-parse), optionally
// DIET_COACH_MODEL (default claude-haiku-5-5) and ALLOWED_ORIGIN.
//
// The call: structured outputs from the zod schema, low effort (a short
// judgement over numbers the app already computed), 15 seconds, one SDK
// retry. Claude Haiku 5.5 has no server-side refusal fallback; a refusal is
// reported and the verdict computed in code stays.
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { CoachAnswer } from './schema.ts'
import { makeHandler, type CoachCall } from './handler.ts'

const env = (name: string) => Deno.env.get(name)
const anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') || 'unset', timeout: 15_000, maxRetries: 1 })

const callModel: CoachCall = async ({ model, system, user }) => {
  try {
    const res = await anthropic.messages.parse({
      model,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(CoachAnswer) },
      system,
      messages: [{ role: 'user', content: user }],
    })
    return { answer: res.stop_reason === 'refusal' ? null : res.parsed_output, stopReason: res.stop_reason }
  } catch (err) {
    // JSON that fails the schema throws from parse(): no answer, so the
    // handler retries once. API errors are rethrown as they are.
    if (err instanceof Anthropic.APIError) throw err
    return { answer: null, stopReason: 'invalid' }
  }
}

Deno.serve(
  makeHandler({
    env,
    userClient: (authHeader) => createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } }),
    adminClient: () => createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!),
    callModel,
  }),
)
