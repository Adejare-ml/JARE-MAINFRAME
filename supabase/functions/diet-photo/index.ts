// Deno, deployed as a Supabase Edge Function: `supabase functions deploy diet-photo`.
//
// Photo analysis for the Diet module (Phase 3, docs/diet-module.md). All the
// logic is in ./handler.ts; this file connects the real clients and the two
// cloud models. The third model, Ollama, runs on the owner's laptop
// (workers/ollama/) and reaches this function with the worker token.
//
// Secrets, set once with `supabase secrets set`:
//
//   ANTHROPIC_API_KEY        Claude (claude-sonnet-5-5); one of the two cloud keys is required
//   NVIDIA_API_KEY           NVIDIA API catalog (build.nvidia.com)
//   DIET_WORKER_TOKEN        a long random string the laptop worker sends; worker actions are off without it
//   NVIDIA_VISION_MODEL      optional; diet_settings.nvidia_vision_model wins when set
//   DIET_PHOTO_CLAUDE_MODEL  optional, default claude-sonnet-5-5
//   (Changed 13 Nov to save cost: the default is now claude-haiku-5-5, see
//   DEFAULTS in handler.ts. Set this to claude-sonnet-5-5 to go back.)
//   NVIDIA_BASE_URL          default https://integrate.api.nvidia.com/v1
//   ALLOWED_ORIGIN           default https://jare-mainframe.pages.dev
//
// Time: the build spec wants a photo logged in under 30 seconds, so both cloud
// models run at once with a 25-second limit each and no SDK-level retries;
// the handler's one retry on an invalid answer is the only second attempt.
//
// Claude: one call per photo, structured outputs from the zod schema, low
// effort (portion estimation from a photo, not long reasoning), and the
// server-side refusal fallback on, as the Claude API guidance recommends for
// claude-sonnet-5-5 ("default" routes a declined request to a suitable model
// in the same call).
//
// NVIDIA: OpenAI-compatible chat completions with the image as a data URL.
// The instructions ride in the user turn, as in analyze-meal, because some
// vision servers on NIM ignore a system turn when an image is present. The
// small (640 px) encoding is sent: NIM takes inline images up to about 180 KB.
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { extractJsonObject } from '../../../src/lib/normalize.js'
import { FoodVision } from './schema.ts'
import { makeHandler, type VisionCall } from './handler.ts'

const env = (name: string) => Deno.env.get(name)
const TIMEOUT_MS = 25_000

const anthropic = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') || 'unset', timeout: TIMEOUT_MS, maxRetries: 0 })

// Added 13 Nov: Haiku has no server-side refusal fallback, so it is called
// plainly, as diet-parse and diet-coach call it; a refusal comes back as
// stop_reason "refusal" and is reported, not retried. Sonnet keeps the
// fallback when DIET_PHOTO_CLAUDE_MODEL names it.
const callClaude: VisionCall = async (args) => (/haiku/i.test(args.model) ? callPlain(args) : callWithFallback(args))

const callPlain: VisionCall = async ({ model, system, user, image, mime }) => {
  try {
    const res = await anthropic.messages.parse({
      model,
      max_tokens: 4000,
      output_config: { effort: 'low', format: zodOutputFormat(FoodVision) },
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/webp', data: image } },
            { type: 'text', text: user },
          ],
        },
      ],
    })
    return { answer: res.stop_reason === 'refusal' ? null : res.parsed_output, stopReason: res.stop_reason }
  } catch (err) {
    if (err instanceof Anthropic.APIError) throw err
    return { answer: null, stopReason: 'invalid' }
  }
}

const callWithFallback: VisionCall = async ({ model, system, user, image, mime }) => {
  try {
    const res = await anthropic.beta.messages.parse({
      model,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: zodOutputFormat(FoodVision) },
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/webp', data: image } },
            { type: 'text', text: user },
          ],
        },
      ],
    })
    return { answer: res.stop_reason === 'refusal' ? null : res.parsed_output, stopReason: res.stop_reason }
  } catch (err) {
    // An answer that is JSON but fails the schema throws from parse(): report
    // it as no answer, so the handler retries once. API errors (key, rate
    // limit, overload, timeout) are rethrown and reported as they are.
    if (err instanceof Anthropic.APIError) throw err
    return { answer: null, stopReason: 'invalid' }
  }
}

const NVIDIA_BASE_URL = (env('NVIDIA_BASE_URL') || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')

const callNvidia: VisionCall = async ({ model, system, user, image, mime }) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('NVIDIA_API_KEY')}`, Accept: 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${system}\n\n---\n\n${user}` },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${image}` } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`NVIDIA ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    return { answer: extractJsonObject(data?.choices?.[0]?.message?.content ?? '') }
  } finally {
    clearTimeout(timer)
  }
}

Deno.serve(
  makeHandler({
    env,
    userClient: (authHeader) => createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } }),
    adminClient: () => createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!),
    callClaude,
    callNvidia,
  }),
)
