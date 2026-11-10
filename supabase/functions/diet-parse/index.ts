// Deno, deployed as a Supabase Edge Function: `supabase functions deploy diet-parse`.
//
// Text and voice logging for the Diet module (Phase 2, docs/diet-module.md):
// the owner's note goes to Claude (claude-haiku-5-5 unless DIET_PARSE_MODEL
// says otherwise) with the owner's own catalogue, comes back as JSON held to
// ./schema.ts, and is matched and priced by src/lib/diet/parse.js. All the
// logic is in ./handler.ts; this file only connects the real clients.
//
// Secrets, set once with `supabase secrets set`:
//
//   ANTHROPIC_API_KEY   required; never sent to the browser
//   DIET_PARSE_MODEL    optional, default claude-haiku-5-5
//   ALLOWED_ORIGIN      default https://jare-mainframe.pages.dev
//
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
// by the platform.
//
// The model call: structured outputs (output_config.format from the zod
// schema) so the answer is JSON in the right shape, low effort (this is
// extraction, not reasoning), and the system prompt split in two so the
// owner's catalogue, the same on every call, sits behind a cache breakpoint.
// Claude Haiku 5.5 has no server-side refusal fallback, so a refusal comes
// back as stop_reason "refusal" and the handler says so instead of retrying.
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { ParseResult } from './schema.ts'
import { makeHandler, type ModelCall } from './handler.ts'

const env = (name: string) => Deno.env.get(name)

const anthropic = new Anthropic({
  apiKey: env('ANTHROPIC_API_KEY') || 'unset',
  // A note is a short extraction; 30 s is generous, and one SDK retry
  // covers a dropped connection or a 529.
  timeout: 30_000,
  maxRetries: 1,
})

const callModel: ModelCall = async ({ model, system, catalog, user }) => {
  try {
    const res = await anthropic.messages.parse({
      model,
      max_tokens: 4000,
      output_config: { effort: 'low', format: zodOutputFormat(ParseResult) },
      system: [
        { type: 'text', text: system },
        { type: 'text', text: catalog, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: user }],
    })
    return {
      parsed: res.stop_reason === 'refusal' ? null : (res.parsed_output ?? null),
      stopReason: res.stop_reason ?? null,
      usage: {
        input_tokens: res.usage?.input_tokens,
        output_tokens: res.usage?.output_tokens,
        cache_read_input_tokens: res.usage?.cache_read_input_tokens,
      },
    }
  } catch (err) {
    // An answer that is valid JSON but fails the zod schema throws from
    // parse(); report it as no usable answer so the handler retries once.
    // API errors (bad key, rate limit, overload) are rethrown as they are.
    if (err instanceof Anthropic.APIError) throw err
    console.warn('diet-parse: answer did not validate:', (err as Error)?.message)
    return { parsed: null, stopReason: 'invalid', usage: null }
  }
}

Deno.serve(
  makeHandler({
    env,
    userClient: (authHeader) =>
      createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } }),
    adminClient: () => createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!),
    callModel,
  }),
)
