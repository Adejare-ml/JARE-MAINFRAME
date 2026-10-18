// Deno, deployed as a Supabase Edge Function: `supabase functions deploy analyze-meal`.
//
// UNVERIFIED IN THIS ENVIRONMENT, like ask-question: no Supabase or Deno CLI
// here, so whoever deploys it first smoke-tests it with a real photo, signed
// in. Secrets, set once with `supabase secrets set`:
//
//   OLLAMA_API_KEY        required for the primary (Ollama Cloud)
//   NVIDIA_API_KEY        optional fallback (NVIDIA NIM)
//   OLLAMA_BASE_URL       default https://ollama.com
//   OLLAMA_VISION_MODEL   default gemma4:31b-cloud (multimodal; the same
//                         model the scheduled scripts use for text)
//   NVIDIA_BASE_URL       default https://integrate.api.nvidia.com/v1
//   NVIDIA_VISION_MODEL   default meta/llama-3.2-90b-vision-instruct (the
//                         text default, openai/gpt-oss-120b, cannot see)
//   ALLOWED_ORIGIN        default https://jare-mainframe.pages.dev
//
// Shape: the same as ask-question. The browser cannot call a model host
// (public/_headers allows connect-src to Supabase only, on purpose), so the
// photo comes here with the caller's own JWT, the pinned owner is checked
// with the service role, and the keys never leave this function. The
// photo is never stored: it is forwarded, read, and dropped.
//
// The prompt (src/lib/mealPrompt.js) and the validator (src/lib/meals.js)
// are the browser's own modules, imported unchanged, so the function and
// the page agree on the JSON shape and the caps.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { MEAL_SYSTEM_PROMPT, buildMealPrompt } from '../../../src/lib/mealPrompt.js'
import { parseMealAnalysis, LIMITS, MEAL_TYPES } from '../../../src/lib/meals.js'
import { extractJsonObject } from '../../../src/lib/sync/normalize.js'

const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') || 'https://jare-mainframe.pages.dev'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  Vary: 'Origin',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

const OLLAMA_API_KEY = Deno.env.get('OLLAMA_API_KEY') || ''
const OLLAMA_BASE_URL = (Deno.env.get('OLLAMA_BASE_URL') || 'https://ollama.com').replace(/\/$/, '')
const OLLAMA_MODEL = Deno.env.get('OLLAMA_VISION_MODEL') || 'gemma4:31b-cloud'
const NVIDIA_API_KEY = Deno.env.get('NVIDIA_API_KEY') || ''
const NVIDIA_BASE_URL = (Deno.env.get('NVIDIA_BASE_URL') || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
const NVIDIA_MODEL = Deno.env.get('NVIDIA_VISION_MODEL') || 'meta/llama-3.2-90b-vision-instruct'

// A vision call is slower than a text one; 60 s each, two providers, inside
// the function's own wall-clock limit.
const REQUEST_TIMEOUT_MS = 60000
// Twelve items with notes is about 700 tokens of JSON; room for a model that
// pads, not for one that rambles.
const MAX_TOKENS = 1200
// NIM accepts an inline base64 image up to about 180 KB; above that it wants
// its assets API. The client sends a second, smaller encoding for this case.
const NVIDIA_INLINE_LIMIT_CHARS = 240000

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

async function withTimeout(fn) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/** Ollama Cloud: native chat endpoint, images on the user turn, JSON-constrained decoding. */
async function callOllama(userPrompt, image) {
  const res = await withTimeout((signal) =>
    fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OLLAMA_API_KEY}` },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: 'json',
        think: false,
        options: { temperature: 0.1, num_predict: MAX_TOKENS },
        messages: [
          { role: 'system', content: MEAL_SYSTEM_PROMPT },
          image ? { role: 'user', content: userPrompt, images: [image] } : { role: 'user', content: userPrompt },
        ],
      }),
      signal,
    }),
  )
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  return data?.message?.content ?? null
}

/**
 * NVIDIA NIM: OpenAI-compatible, the image as a data URL content part.
 *
 * The instructions ride in the user turn, ahead of the image: the Llama
 * vision servers on NIM ignore or reject a system role when an image is
 * present, and a model that never saw the schema answers in prose.
 */
async function callNvidia(userPrompt, image, mime) {
  const text = `${MEAL_SYSTEM_PROMPT}

---

${userPrompt}`
  const content = image
    ? [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${image}` } },
      ]
    : text
  const res = await withTimeout((signal) =>
    fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${NVIDIA_API_KEY}` },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [{ role: 'user', content }],
        temperature: 0.1,
        max_tokens: MAX_TOKENS,
        // No response_format: the vision models on NIM do not all accept it,
        // and extractJsonObject copes with a code fence or a leading sentence.
      }),
      signal,
    }),
  )
  if (!res.ok) throw new Error(`NVIDIA ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data = await res.json()
  const choice = data?.choices?.[0]
  if (choice?.finish_reason === 'length') {
    throw new Error(`NVIDIA response hit the ${MAX_TOKENS}-token cap before finishing`)
  }
  return choice?.message?.content ?? null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  // Answered without a model call, so Settings → System can tell "deployed"
  // from "not deployed".
  if (req.method === 'GET') {
    return json({ ok: true, service: 'analyze-meal', providers: { ollama: Boolean(OLLAMA_API_KEY), nvidia: Boolean(NVIDIA_API_KEY) } })
  }
  if (req.method !== 'POST') return json({ ok: false, reason: 'POST only' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ ok: false, reason: 'missing Authorization header' }, 401)

  // Every failure from here on is a 200 with ok:false. supabase-js's
  // functions.invoke turns a non-2xx into a thrown error whose body the page
  // cannot read without extra ceremony, and "could not read the photo:
  // Ollama 429" is something the owner should see, not "non-2xx status".
  if (!OLLAMA_API_KEY && !NVIDIA_API_KEY) {
    return json({ ok: false, reason: 'the meal service is not configured (no model provider key set)' })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, reason: 'malformed request body' })
  }

  const image = typeof body?.image === 'string' ? body.image.replace(/\s+/g, '') : ''
  const imageSmall = typeof body?.imageSmall === 'string' ? body.imageSmall.replace(/\s+/g, '') : ''
  const mime = body?.mime === 'image/png' || body?.mime === 'image/webp' ? body.mime : 'image/jpeg'
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, LIMITS.textChars) : ''
  const hint = typeof body?.hint === 'string' ? body.hint.trim().slice(0, LIMITS.hintChars) : ''
  const mealType = MEAL_TYPES.includes(body?.mealType) ? body.mealType : ''
  const localTime = typeof body?.localTime === 'string' && /^\d{2}:\d{2}$/.test(body.localTime) ? body.localTime : ''
  const quality =
    body?.quality && typeof body.quality === 'object'
      ? {
          note: typeof body.quality.note === 'string' ? body.quality.note.slice(0, 200) : '',
          corrected: body.quality.corrected === true,
        }
      : null

  if (!image && !text) return json({ ok: false, reason: 'send a photo or a description' })
  if (image && (image.length > LIMITS.imageBase64Chars || !BASE64.test(image))) {
    return json({ ok: false, reason: 'the photo is too large or not base64; the app resizes before sending' })
  }
  if (imageSmall && (imageSmall.length > LIMITS.imageBase64Chars || !BASE64.test(imageSmall))) {
    return json({ ok: false, reason: 'the small photo is not base64' })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData?.user) return json({ ok: false, reason: 'not signed in' }, 401)

  // The owner only, same as ask-question: RLS keeps a stray account's rows
  // apart, but nothing in RLS stops them spending the owner's model key one
  // photo at a time.
  const admin = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: pinned } = await admin.from('jare_owner').select('user_id').limit(1).maybeSingle()
  if (!pinned?.user_id || pinned.user_id !== userData.user.id) {
    return json({ ok: false, reason: 'this service answers its owner only' }, 403)
  }

  const userPrompt = buildMealPrompt({ hasImage: Boolean(image), text, hint, quality, mealType, localTime })

  const providers = [
    { name: 'ollama', model: OLLAMA_MODEL, enabled: Boolean(OLLAMA_API_KEY), call: () => callOllama(userPrompt, image || null) },
    {
      name: 'nvidia',
      model: NVIDIA_MODEL,
      enabled: Boolean(NVIDIA_API_KEY),
      call: () => {
        // Inline limit: prefer the small encoding when the full one is over it.
        const pick = image && image.length > NVIDIA_INLINE_LIMIT_CHARS && imageSmall ? imageSmall : image
        return callNvidia(userPrompt, pick || null, mime)
      },
    },
  ]

  const started = Date.now()
  const failures = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    try {
      const content = await provider.call()
      const parsed = extractJsonObject(content)
      if (!parsed) {
        failures.push(`${provider.name}: no JSON object in the response`)
        continue
      }
      const checked = parseMealAnalysis(parsed)
      if (!checked.ok) {
        failures.push(`${provider.name}: ${checked.reason}`)
        continue
      }
      return json({
        ok: true,
        analysis: checked.analysis,
        provider: provider.name,
        model: provider.model,
        elapsedMs: Date.now() - started,
      })
    } catch (err) {
      const reason = err?.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err?.message
      failures.push(`${provider.name}: ${reason}`)
    }
  }

  // Which provider failed and why, in the log; a short version to the page.
  console.warn('analyze-meal: every provider failed:', failures.join(' | '))
  return json({ ok: false, reason: `could not read the photo: ${failures.join('; ').slice(0, 300)}` })
})
