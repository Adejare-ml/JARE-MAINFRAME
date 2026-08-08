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

// Defaults are the models chosen during design. They have never been called
// successfully, so treat them as unverified until `node scripts/test-llm.mjs`
// passes -- if either ID is wrong, override it with a repository variable
// rather than editing this file.
const OLLAMA_API_KEY = env('OLLAMA_API_KEY')
const NVIDIA_API_KEY = env('NVIDIA_API_KEY')
const OLLAMA_BASE_URL = env('OLLAMA_BASE_URL', 'https://ollama.com')
const OLLAMA_MODEL = env('OLLAMA_MODEL', 'gemma4:31b-cloud')
const NVIDIA_BASE_URL = env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1')
const NVIDIA_MODEL = env('NVIDIA_MODEL', 'deepseek-ai/deepseek-v4-flash')

/** Extraction is a short, mechanical job -- a long budget only buys a model
 *  room to ramble past the JSON. */
const MAX_TOKENS = 500
const REQUEST_TIMEOUT_MS = 30000
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
async function callOllama(userPrompt) {
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
        options: { temperature: 0, num_predict: MAX_TOKENS },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
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
async function callNvidia(userPrompt) {
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
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        // Ignored by non-reasoning models; suppresses the <think> block on
        // those that support it. extractJsonObject copes either way.
        chat_template_kwargs: { thinking: false },
      }),
      signal,
    }),
  )

  if (!res.ok) {
    throw new Error(`NVIDIA ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }

  const data = await res.json()
  return data?.choices?.[0]?.message?.content ?? null
}

/**
 * Extract a transaction from an email body.
 *
 * @param {string} emailBody
 * @param {(msg: string) => void} [warn]
 * @returns {Promise<{data: object, provider: 'ollama'|'nvidia'} | null>}
 */
export async function extractTransaction(emailBody, warn = console.warn) {
  const userPrompt = `Parse this bank notification email:\n\n${emailBody.slice(0, MAX_BODY_CHARS)}`

  const providers = [
    { name: 'ollama', enabled: LLM_CONFIG.ollama.configured, call: callOllama },
    { name: 'nvidia', enabled: LLM_CONFIG.nvidia.configured, call: callNvidia },
  ]

  for (const provider of providers) {
    if (!provider.enabled) continue

    try {
      const content = await provider.call(userPrompt)
      const parsed = extractJsonObject(content)

      if (!parsed) {
        warn(`   ${provider.name}: no JSON object in response`)
        continue
      }
      if (parsed.error) {
        // The model read the email and says it isn't a transaction. That is an
        // answer, not a failure -- don't burn the fallback provider on it.
        return null
      }

      return { data: parsed, provider: provider.name }
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message
      warn(`   ${provider.name} failed: ${reason}`)
    }
  }

  return null
}
