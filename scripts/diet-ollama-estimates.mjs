#!/usr/bin/env node
/**
 * The third photo estimate, from Ollama Cloud, run on GitHub Actions.
 *
 * The same loop as the laptop worker (workers/ollama/worker.py), against the
 * same diet-photo actions: `pending` hands out up to three recent photo
 * meals with no Ollama answer yet (a signed photo URL, the filled prompt),
 * the model reads each photo, and `estimate` stores the answer and re-merges
 * the meal. The edge function checks the answer against its zod schema
 * before anything is stored, so this script only decides whether to retry.
 *
 * The laptop worker stays an option; whichever answers first for a meal
 * wins, and the other then finds nothing pending.
 *
 * The worker token is not a secret of its own: it is derived from the
 * service key (scripts/lib/workerToken.mjs), and the deploy workflow sets
 * the same value on the edge function.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, OLLAMA_API_KEY, optional
 * OLLAMA_VISION_MODEL (default gemma4:31b-cloud), OLLAMA_BASE_URL.
 *
 * Added after Phase 4, at the owner's request ("Ollama Cloud, from GitHub").
 */
import { workerToken } from './lib/workerToken.mjs'
import { askOllama, hasOllama, OLLAMA_VISION_MODEL } from './lib/models.mjs'
import { checkVision, FOOD_VISION_JSON_SCHEMA } from '../src/lib/diet/visionSchema.js'

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env

async function callFunction(body) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/diet-photo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      apikey: SUPABASE_SERVICE_KEY,
      'x-worker-token': workerToken(SUPABASE_SERVICE_KEY),
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (res.status !== 200 || !data.ok) throw new Error(`diet-photo ${res.status}: ${data.reason || data.msg || data.message || 'no detail'}`)
  return data
}

async function estimateOne(job, model) {
  const photo = await fetch(job.image_url)
  if (!photo.ok) throw new Error(`photo download ${photo.status}`)
  const image = { base64: Buffer.from(await photo.arrayBuffer()).toString('base64'), mime: photo.headers.get('content-type') || 'image/jpeg' }
  const started = Date.now()
  const reasons = []
  for (const attempt of [1, 2]) {
    const reply = await askOllama({ model, system: job.system, user: job.user, image, schema: FOOD_VISION_JSON_SCHEMA, timeoutMs: 120000 })
    if (!reply.ok) {
      reasons.push(`attempt ${attempt}: ${reply.reason}`)
      if (reply.status === 'error' && /timed out|5\d\d/.test(reply.reason)) continue
      return { status: 'error', answer: null, reason: reasons.join('; '), attempts: attempt, latency_ms: Date.now() - started, model_id: model }
    }
    const checked = checkVision(reply.text)
    if (checked.ok) return { status: 'ok', answer: checked.answer, reason: null, attempts: attempt, latency_ms: Date.now() - started, model_id: model }
    reasons.push(`attempt ${attempt}: ${checked.reason}`)
  }
  return { status: 'invalid', answer: null, reason: reasons.join('; ').slice(0, 300), attempts: 2, latency_ms: Date.now() - started, model_id: model }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
  if (!hasOllama()) {
    console.log('OLLAMA_API_KEY is not set: nothing to do.')
    return
  }
  const { jobs = [] } = await callFunction({ action: 'pending' })
  if (jobs.length === 0) {
    console.log('No photo meals waiting for an Ollama estimate.')
    return
  }
  // The pending job names the laptop model from Diet settings; a cloud run
  // uses a cloud model unless that setting already names one.
  const model = jobs[0].model && /-cloud$/.test(jobs[0].model) ? jobs[0].model : OLLAMA_VISION_MODEL()
  console.log(`${jobs.length} photo meal(s) to read with ${model}`)
  let failures = 0
  for (const job of jobs) {
    try {
      const result = await estimateOne(job, model)
      const reply = await callFunction({ action: 'estimate', meal_id: job.meal_id, ...result })
      console.log(`   meal ${job.meal_id.slice(0, 8)}: ${reply.stored || result.status}, ${reply.remerged ?? 'none'} (${result.latency_ms} ms)${result.reason ? ` -- ${result.reason}` : ''}`)
    } catch (err) {
      failures++
      console.warn(`   meal ${job.meal_id.slice(0, 8)}: ${err.message} (tried again next run)`)
    }
  }
  if (failures === jobs.length) throw new Error('every photo failed this run')
}

main().catch((err) => {
  console.error(`Ollama estimates failed: ${err.message}`)
  process.exit(1)
})
