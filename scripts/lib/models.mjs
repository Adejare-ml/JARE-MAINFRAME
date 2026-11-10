/**
 * Claude and Ollama Cloud, for the Diet jobs that run on GitHub Actions
 * (diet-checkin, diet-ollama-estimates, diet-image-test). Plain fetch, so
 * the scripts need no SDK in package.json; the keys come from the workflow's
 * env (GitHub secrets) and are never logged.
 *
 * Claude: the Messages API with structured outputs (output_config.format),
 * so the answer is JSON of the schema given. A refusal is reported, not
 * retried. Ollama: /api/chat with `format` set to the same schema.
 *
 * Added after Phase 4 (docs/diet-module.md, "GitHub jobs").
 */

function env(name, fallback = '') {
  const raw = process.env[name]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
}

export const CLAUDE_TEXT_MODEL = () => env('DIET_CLAUDE_TEXT_MODEL', 'claude-haiku-5-5')
export const CLAUDE_VISION_MODEL = () => env('DIET_PHOTO_CLAUDE_MODEL', 'claude-sonnet-5-5')
export const OLLAMA_TEXT_MODEL = () => env('OLLAMA_MODEL', 'gemma4:31b-cloud')
export const OLLAMA_VISION_MODEL = () => env('OLLAMA_VISION_MODEL', 'gemma4:31b-cloud')
// Changed after the first image test (10 Nov): meta/llama-3.2-90b-vision-instruct
// took 40 to 60 s a photo and refused most of them ("I cannot provide...").
// The second image test found meta/llama-4-maverick-17b-128e-instruct retired
// (410 Gone), so the default is back to the model the edge function uses until
// the catalog listing below names a better one (repository variable
// NVIDIA_VISION_MODEL overrides it without a code change).
// Third run (10 Nov): llama-3.2-90b-vision timed out on 6 of 8 photos. The
// catalog listed google/gemma-4-31b-it and nvidia/nemotron-3.5-super-vl-120b-a12b
// as current vision models; Gemma 4 is tried first (the same family as the
// Ollama default, so the two can be compared). It answered 7 of 8 photos in
// the fourth run and is now the default here and in diet-photo.
export const NVIDIA_VISION_MODEL = () => env('NVIDIA_VISION_MODEL', 'google/gemma-4-31b-it')

/** The NVIDIA catalog's model ids that look like they read images, for the image test's report. */
export async function nvidiaVisionModels() {
  const base = env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
  try {
    const res = await timed(15000, (signal) => fetch(`${base}/models`, { headers: { Authorization: `Bearer ${env('NVIDIA_API_KEY')}` }, signal }))
    if (!res.ok) return { ok: false, reason: `NVIDIA ${res.status}` }
    const ids = ((await res.json())?.data || []).map((m) => m.id)
    return { ok: true, ids: ids.filter((id) => /vision|-vl|vlm|multimodal|maverick|scout|gemma-3|gemma-4|pixtral|qwen.*vl|llava|kimi.*vl|phi-4-multi/i.test(id)).sort() }
  } catch (err) {
    return { ok: false, reason: String(err.message).slice(0, 100) }
  }
}

export const hasClaude = () => Boolean(env('ANTHROPIC_API_KEY'))
export const hasOllama = () => Boolean(env('OLLAMA_API_KEY'))
export const hasNvidia = () => Boolean(env('NVIDIA_API_KEY'))

async function timed(ms, fn) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fn(ctrl.signal)
  } finally {
    clearTimeout(t)
  }
}

/**
 * One Claude call. `image` is {base64, mime} or null. Returns
 * {ok, text, model, ms} or {ok:false, status, reason, ms}.
 */
export async function askClaude({ model = CLAUDE_TEXT_MODEL(), system, user, schema, image = null, maxTokens = 2000, timeoutMs = 60000 }) {
  const started = Date.now()
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } }, { type: 'text', text: user }]
    : user
  try {
    const res = await timed(timeoutMs, (signal) =>
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content }],
          ...(schema ? { output_config: { format: { type: 'json_schema', schema } } } : {}),
        }),
        signal,
      }),
    )
    const data = await res.json().catch(() => ({}))
    const ms = Date.now() - started
    if (!res.ok) return { ok: false, status: 'error', reason: `Claude ${res.status}: ${data?.error?.message || 'no detail'}`.slice(0, 300), ms }
    if (data.stop_reason === 'refusal') return { ok: false, status: 'refused', reason: 'Claude declined', ms }
    if (data.stop_reason === 'max_tokens') return { ok: false, status: 'invalid', reason: 'Claude ran out of tokens', ms }
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
    return { ok: true, text, model: data.model || model, ms }
  } catch (err) {
    return { ok: false, status: 'error', reason: err.name === 'AbortError' ? `Claude timed out after ${timeoutMs / 1000}s` : String(err.message).slice(0, 200), ms: Date.now() - started }
  }
}

/** One Ollama Cloud call, same return shape as askClaude. */
export async function askOllama({ model = OLLAMA_TEXT_MODEL(), system, user, schema = 'json', image = null, timeoutMs = 90000 }) {
  const started = Date.now()
  const base = env('OLLAMA_BASE_URL', 'https://ollama.com').replace(/\/$/, '')
  try {
    const res = await timed(timeoutMs, (signal) =>
      fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('OLLAMA_API_KEY')}` },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          format: schema,
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user, ...(image ? { images: [image.base64] } : {}) },
          ],
        }),
        signal,
      }),
    )
    const ms = Date.now() - started
    if (!res.ok) return { ok: false, status: 'error', reason: `Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`, ms }
    const data = await res.json()
    return { ok: true, text: data?.message?.content ?? '', model, ms }
  } catch (err) {
    return { ok: false, status: 'error', reason: err.name === 'AbortError' ? `Ollama timed out after ${timeoutMs / 1000}s` : String(err.message).slice(0, 200), ms: Date.now() - started }
  }
}

/** One NVIDIA NIM vision call (OpenAI-compatible), same return shape. */
export async function askNvidia({ model = NVIDIA_VISION_MODEL(), system, user, image, timeoutMs = 60000 }) {
  const started = Date.now()
  const base = env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')
  try {
    const res = await timed(timeoutMs, (signal) =>
      fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('NVIDIA_API_KEY')}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }] },
          ],
        }),
        signal,
      }),
    )
    const ms = Date.now() - started
    if (!res.ok) return { ok: false, status: 'error', reason: `NVIDIA ${res.status}: ${(await res.text()).slice(0, 200)}`, ms }
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content ?? ''
    const match = String(text).match(/\{[\s\S]*\}/)
    return { ok: true, text: match ? match[0] : text, model, ms }
  } catch (err) {
    return { ok: false, status: 'error', reason: err.name === 'AbortError' ? `NVIDIA timed out after ${timeoutMs / 1000}s` : String(err.message).slice(0, 200), ms: Date.now() - started }
  }
}
