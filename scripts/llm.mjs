/**
 * LLM transaction extraction, with Ollama Cloud primary and NVIDIA NIM fallback.
 *
 * Used only where rules cannot work. Some providers -- Opay, PiggyVest --
 * describe money in and money out with the same word, so direction is not
 * recoverable from keywords and has to be reasoned about.
 *
 * Endpoints and model IDs come from the environment. A model being renamed or
 * retired should be a secret change, not a code change and a redeploy.
 */

import { ALL_CATEGORIES } from '../src/lib/constants.js'
import { extractJsonObject } from '../src/lib/sync/normalize.js'
import {
  CATEGORIZE_SYSTEM_PROMPT,
  BATCH_MAX_TOKENS,
  buildBatchPrompt,
  parseBatchResponse,
} from '../src/lib/sync/batchPrompt.js'

/**
 * Read an env var, treating blank as absent.
 *
 * A destructuring default only fires on `undefined`, and GitHub Actions renders
 * an unset `vars.X` as an empty string while still exporting it. So
 * `OLLAMA_BASE_URL: ${{ vars.OLLAMA_BASE_URL }}` with no variable configured
 * produced `''`, the default never applied, and `fetch('/api/chat')` threw a
 * URL parse error on every call -- silently, because hasAnyProvider() was still
 * true and the failure landed in the parse-failure count.
 *
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function env(name, fallback = '') {
  const raw = process.env[name]
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback
}

// Both defaults are overridable by repository variable, so a model that is
// renamed or retired needs no code change. Change them here only when the
// default itself has gone stale -- which is why NVIDIA's moved: the verify job
// on 9 Aug 2026 got `410 Gone -- deepseek-ai/deepseek-v4-flash has reached its
// end of life on 2026-08-07`, two days after the fact, having never once been
// called successfully before that.
//
// Ollama's default is verified: gemma4:31b-cloud answered in 1.3s with correct
// direction, amount and clean JSON on the Opay fixture.
const OLLAMA_API_KEY = env('OLLAMA_API_KEY')
const NVIDIA_API_KEY = env('NVIDIA_API_KEY')
const OLLAMA_BASE_URL = env('OLLAMA_BASE_URL', 'https://ollama.com')
const OLLAMA_MODEL = env('OLLAMA_MODEL', 'gemma4:31b-cloud')
const NVIDIA_BASE_URL = env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1')
const NVIDIA_MODEL = env('NVIDIA_MODEL', 'openai/gpt-oss-120b')

/** Extraction is a short, mechanical job -- a long budget only buys a model
 *  room to ramble past the JSON. */
const MAX_TOKENS = 500

/**
 * NVIDIA gets a larger ceiling than Ollama.
 *
 * The fallback model reasons by default, and while we ask for the least of it
 * (see NVIDIA_REASONING_EFFORT), max_tokens is a hard stop rather than a hint:
 * a model that reasons anyway spends the budget narrating and gets cut off
 * mid-JSON.
 * The cost is charged on output actually produced, not on the cap, so a
 * generous ceiling is close to free and buys a truncated answer the room to
 * still land.
 */
const NVIDIA_MAX_TOKENS = 1500
const NVIDIA_BATCH_MAX_TOKENS = 2500

/**
 * Keeping the NVIDIA model from thinking the request to death.
 *
 * The previous version of this sent `chat_template_kwargs: {enable_thinking,
 * thinking}`, which is how NIM drove DeepSeek V4 Flash. That model was retired
 * on 2026-08-07, and its replacement, openai/gpt-oss-120b, takes the
 * OpenAI-standard `reasoning_effort` as a top-level parameter instead -- so the
 * old keys were inert here and the model reasoned freely.
 *
 * Evidence rather than inference: the first probe against gpt-oss returned
 * `timed out after 30000ms` -- no status code, no partial body, nothing to
 * parse. Not the truncation the DeepSeek fix anticipated, because the response
 * never arrived at all. Ollama answered the same prompt in 1.5s.
 *
 * 'low' because extraction is mechanical. There is nothing in a bank alert
 * worth deliberating over, and every reasoning token is one the JSON does not
 * get -- and, at 120B, several hundred milliseconds nobody is waiting for.
 */
const NVIDIA_REASONING_EFFORT = 'low'

/**
 * 60s rather than 30s.
 *
 * gemma4:31b-cloud answers in ~1.5s, so this ceiling never binds for the
 * primary. It exists for the fallback: a 120B model on a shared endpoint is
 * legitimately slower than a 31B one, and 30s turned out to be inside the range
 * where a real answer and a hung request look identical. Raising it costs a
 * four-hourly cron job nothing and removes that ambiguity.
 */
const REQUEST_TIMEOUT_MS = 60000
/** Enough for any alert; keeps a pathological email from blowing the context. */
const MAX_BODY_CHARS = 3000

export const LLM_CONFIG = {
  ollama: { baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, configured: Boolean(OLLAMA_API_KEY) },
  nvidia: { baseUrl: NVIDIA_BASE_URL, model: NVIDIA_MODEL, configured: Boolean(NVIDIA_API_KEY) },
}

export function hasAnyProvider() {
  return LLM_CONFIG.ollama.configured || LLM_CONFIG.nvidia.configured
}

/**
 * The category list is interpolated from the app's own constants rather than
 * retyped, so the prompt cannot drift from what the UI can display.
 */
export const SYSTEM_PROMPT = `You are a financial email parser for Nigerian bank and fintech notifications.
Extract the transaction and return ONLY a JSON object. No prose, no markdown, no reasoning.

{
  "type": "debit" or "credit",
  "amount": number (no currency symbol, no thousands separators),
  "currency": "NGN",
  "description": "short human description of the transaction",
  "recipient": "the other party's name, or null",
  "category": one of: ${ALL_CATEGORIES.join(' | ')},
  "transaction_date": "YYYY-MM-DD",
  "transaction_time": "HH:MM:SS" (24-hour),
  "transaction_id": "the bank's reference or transaction number, or null",
  "available_balance": number or null
}

Rules:
- "type" is the direction relative to THIS account. Money leaving is "debit";
  money arriving is "credit". Some providers use the word "transfer" for both,
  so decide from context -- who is named as sender and who as receiver, and
  whether the balance went up or down -- not from the word "transfer" alone.
- "category" must be copied exactly from the list above. If nothing fits, use
  "Uncategorized".
- Never invent a transaction_id. Use null when the email does not state one.
If the email is not a transaction notification, return {"error": "unparseable"}.`

async function withTimeout(fn) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ollama Cloud. Uses the native /api/chat endpoint with format:"json", which
 * constrains decoding to valid JSON rather than merely asking for it.
 */
async function callOllama(userPrompt, systemPrompt = SYSTEM_PROMPT, maxTokens = MAX_TOKENS) {
  const res = await withTimeout((signal) =>
    fetch(`${OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OLLAMA_API_KEY}`,
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: 'json',
        think: false,
        options: { temperature: 0, num_predict: maxTokens },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal,
    }),
  )

  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  const data = await res.json()
  return data?.message?.content ?? null
}

/**
 * NVIDIA NIM, OpenAI-compatible. Reasoning is switched off: a thinking model
 * spends the token budget narrating and can push the JSON past the limit.
 */
async function callNvidia(userPrompt, systemPrompt = SYSTEM_PROMPT, maxTokens = MAX_TOKENS) {
  // Scale the caller's budget up for this provider; see NVIDIA_MAX_TOKENS.
  const budget = maxTokens > MAX_TOKENS ? NVIDIA_BATCH_MAX_TOKENS : NVIDIA_MAX_TOKENS

  const res = await withTimeout((signal) =>
    fetch(`${NVIDIA_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: budget,
        response_format: { type: 'json_object' },
        // Top-level and OpenAI-standard, which is what gpt-oss reads. Ignored
        // by models that do not reason. See NVIDIA_REASONING_EFFORT.
        reasoning_effort: NVIDIA_REASONING_EFFORT,
      }),
      signal,
    }),
  )

  if (!res.ok) {
    throw new Error(`NVIDIA ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  const data = await res.json()
  const choice = data?.choices?.[0]

  // Truncation and malformed JSON are indistinguishable downstream -- both
  // surface as "no JSON object in response". Naming it here is the difference
  // between "raise the budget" and "the model is broken".
  if (choice?.finish_reason === 'length') {
    throw new Error(
      `NVIDIA response hit the ${budget}-token cap before finishing. ` +
        'The model is probably still reasoning despite chat_template_kwargs.',
    )
  }

  return choice?.message?.content ?? null
}

/**
 * Ask whichever provider answers first, and hand back the parsed JSON.
 *
 * The primary-then-fallback loop was written out twice here before this
 * existed, and a third caller was one copy away from being the version that
 * forgot to check `finish_reason` or to log which provider failed. The loop is
 * identical every time; only the prompt, the budget and what counts as "the
 * model declined" differ, so those are the parameters.
 *
 * Returns null when every configured provider fails or none is configured --
 * never throws. Each caller decides what an absent answer means, because the
 * right response differs: the sync sends the email to the review queue, and the
 * planner writes no drafts at all.
 *
 * @param {string} userPrompt
 * @param {{system?: string, maxTokens?: number, warn?: (msg: string) => void, label?: string, declined?: (parsed: object) => boolean}} [options]
 * @returns {Promise<{data: object, provider: 'ollama'|'nvidia'} | null>}
 */
export async function callModel(
  userPrompt,
  { system = SYSTEM_PROMPT, maxTokens = MAX_TOKENS, warn = console.warn, label = '', declined } = {},
) {
  const providers = [
    { name: 'ollama', enabled: LLM_CONFIG.ollama.configured, call: callOllama },
    { name: 'nvidia', enabled: LLM_CONFIG.nvidia.configured, call: callNvidia },
  ]

  const what = label ? ` ${label}` : ''

  for (const provider of providers) {
    if (!provider.enabled) continue

    try {
      const content = await provider.call(userPrompt, system, maxTokens)
      const parsed = extractJsonObject(content)

      if (!parsed) {
        warn(`   ${provider.name}: no JSON object in${what} response`)
        continue
      }

      // The model answered, and the answer is "I can't". That is a result, not
      // a failure -- burning the fallback provider on it would double the cost
      // of every unparseable email for no chance of a different reply.
      if (declined && declined(parsed)) return null

      return { data: parsed, provider: provider.name }
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message
      warn(`   ${provider.name}${what} failed: ${reason}`)
    }
  }

  return null
}

/**
 * Extract a transaction from an email body.
 *
 * @param {string} emailBody
 * @param {(msg: string) => void} [warn]
 * @returns {Promise<{data: object, provider: 'ollama'|'nvidia'} | null>}
 */
export async function extractTransaction(emailBody, warn = console.warn) {
  return callModel(`Parse this bank notification email:\n\n${emailBody.slice(0, MAX_BODY_CHARS)}`, {
    warn,
    declined: (parsed) => Boolean(parsed.error),
  })
}

/**
 * Categorize a batch of transactions and explain each one.
 *
 * Separate from extractTransaction on purpose. Extraction is expensive and
 * per-email, and is only needed when the rules parsers cannot read a bank's
 * format at all. Categorization is needed for *every* transaction, so it is
 * batched: ten per request turns a hundred-email sync from a hundred calls into
 * ten, which matters on a free tier and on a 30-second timeout.
 *
 * Never throws. A failed batch returns Uncategorized/LOW for every item in it,
 * which sends them to the review queue instead of failing the sync.
 *
 * @param {Array<{id: string, type: string, amount: number, description?: string, recipient?: string, walletName?: string}>} items
 * @param {Array} [corrections] - recent manual corrections, used as examples
 * @param {(msg: string) => void} [warn]
 * @returns {Promise<{results: Array, provider: string|null}>}
 */
export async function categorizeBatch(items, corrections = [], warn = console.warn) {
  if (!items || items.length === 0) return { results: [], provider: null }

  const answer = await callModel(buildBatchPrompt(items, corrections), {
    system: CATEGORIZE_SYSTEM_PROMPT,
    maxTokens: BATCH_MAX_TOKENS,
    label: 'categorization',
    warn,
  })

  // parseBatchResponse guarantees one result per requested id, so a
  // half-answered batch still yields a usable array -- and a null answer, when
  // both providers are unavailable, sends everything to review rather than
  // nowhere.
  return {
    results: parseBatchResponse(answer?.data ?? null, items),
    provider: answer?.provider ?? null,
  }
}

/**
 * Call one named provider directly and report what happened.
 *
 * Used by scripts/test-llm.mjs, which needs to know whether *each* provider
 * works rather than whether *any* does. extractTransaction deliberately stops
 * at the first success, which is right for syncing and useless for diagnosis:
 * it cannot tell you the fallback is broken until the primary also is.
 *
 * @param {'ollama'|'nvidia'} name
 * @param {string} emailBody
 * @returns {Promise<{ok: true, data: object} | {ok: false, error: string}>}
 */
export async function probeProvider(name, emailBody) {
  const call = name === 'ollama' ? callOllama : callNvidia
  const userPrompt = `Parse this bank notification email:\n\n${emailBody.slice(0, MAX_BODY_CHARS)}`

  try {
    const content = await call(userPrompt)
    if (!content) return { ok: false, error: 'empty response' }

    const parsed = extractJsonObject(content)
    if (!parsed) {
      return { ok: false, error: `no JSON object in response: ${String(content).slice(0, 200)}` }
    }
    if (parsed.error) {
      return { ok: false, error: `model says unparseable: ${parsed.error}` }
    }

    return { ok: true, data: parsed }
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message
    return { ok: false, error: reason }
  }
}
