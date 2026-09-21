// Deno, deployed as a Supabase Edge Function: `supabase functions deploy ask-question`.
//
// UNVERIFIED. This environment has no Supabase or Deno CLI, so this has never
// been run or deployed. Whoever deploys it first must smoke-test a real
// question -- signed in, real data -- before relying on it. Also needs
// `supabase secrets set OLLAMA_API_KEY=...` (and OLLAMA_BASE_URL/OLLAMA_MODEL
// if overriding the defaults below); these are Edge Function secrets, a
// separate store from the GitHub Actions repo variables scripts/llm.mjs reads.
//
// Thin on purpose. Every model call elsewhere in this codebase
// (gmail-sync.mjs, plan-month.mjs, weekly-recap.mjs) runs from a scheduled
// GitHub Action with a service-role key, against no particular signed-in
// user. Answering a typed question is the opposite shape -- a live round
// trip, started by the person asking it -- so this is the one place in the
// app that reads the CALLER'S OWN JWT instead of a service-role key.
// Supabase RLS (auth.uid() = user_id, on every table fetched below) is what
// actually scopes every query to that one person's data; nothing here does
// its own filtering by user id.
//
// The question-answering logic itself is neither new nor untested:
// buildNlQueryPrompt/NL_QUERY_SYSTEM_PROMPT (src/lib/nlQueryPrompt.js) and
// runQuery (src/lib/nlQuery.js) already ship fully unit-tested from Stage E,
// confirmed plain-ESM with no Node- or browser-only APIs, so they load here
// unchanged. This file is only the fetch-data / call-the-model / return-JSON
// glue around them -- no second "turn it into a sentence" LLM call, so a
// wrong answer can't slip in below the citation-style discipline runQuery
// already enforces.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { buildNlQueryPrompt, NL_QUERY_SYSTEM_PROMPT } from '../../../src/lib/nlQueryPrompt.js'
import { runQuery } from '../../../src/lib/nlQuery.js'
import { extractJsonObject } from '../../../src/lib/sync/normalize.js'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

const OLLAMA_BASE_URL = Deno.env.get('OLLAMA_BASE_URL') || 'https://ollama.com'
const OLLAMA_MODEL = Deno.env.get('OLLAMA_MODEL') || 'gemma4:31b-cloud'
const OLLAMA_API_KEY = Deno.env.get('OLLAMA_API_KEY') || ''
const REQUEST_TIMEOUT_MS = 60000
// Choosing one function name plus a couple of short arguments is a short
// answer -- nowhere near scripts/llm.mjs's transaction-extraction budget.
const MAX_TOKENS = 300

/**
 * Ollama Cloud only. scripts/llm.mjs's callModel() also falls back to NVIDIA
 * NIM when Ollama fails -- deliberately left out here to keep this handler
 * thin for a first version. Add it the same way (see callNvidia there) if
 * Ollama's reliability in practice doesn't hold up for a live request a
 * person is waiting on.
 */
async function callOllama(userPrompt) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(`${OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`, {
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
          { role: 'system', content: NL_QUERY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const data = await res.json()
    return data?.message?.content ?? null
  } finally {
    clearTimeout(timer)
  }
}

/** First of the current UTC month, as YYYY-MM-DD. */
function startOfMonthISO() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ ok: false, reason: 'POST only' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ ok: false, reason: 'missing Authorization header' }, 401)

  if (!OLLAMA_API_KEY) {
    return json(
      { ok: false, reason: 'the question service is not configured (no model provider key set)' },
      503,
    )
  }

  let question
  try {
    const body = await req.json()
    question = typeof body?.question === 'string' ? body.question.trim() : ''
  } catch {
    return json({ ok: false, reason: 'malformed request body' }, 400)
  }
  if (!question) return json({ ok: false, reason: 'no question given' }, 400)

  const supabase = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData?.user) {
    return json({ ok: false, reason: 'not signed in' }, 401)
  }

  const monthStart = startOfMonthISO()

  // RLS scopes every one of these to the caller alone -- nothing here adds
  // its own `.eq('user_id', ...)` filter. `debts` matches Daily HQ's own
  // `.eq('settled', false)` precedent: debtTotals only ever wants open debts.
  const [walletsRes, transactionsRes, goalsRes, debtsRes] = await Promise.all([
    supabase.from('wallets').select('*'),
    supabase.from('transactions').select('*').gte('transaction_date', monthStart),
    supabase.from('goals').select('*'),
    supabase.from('debts').select('*').eq('settled', false),
  ])

  const firstError = walletsRes.error || transactionsRes.error || goalsRes.error || debtsRes.error
  if (firstError) {
    return json({ ok: false, reason: `could not load data: ${firstError.message}` }, 500)
  }

  const wallets = walletsRes.data || []
  const activeWallets = wallets.filter((w) => w.is_active !== false)
  const liquidWalletIds = new Set(
    activeWallets.filter((w) => ['bank', 'mobile', 'cash'].includes(w.type)).map((w) => w.id),
  )
  // goalProgress already skips voided rows itself, but summarizeMonth does
  // not -- filtering once here, same as every page's own recentRows, keeps
  // both context fields consistent with what's on screen.
  const monthTransactions = (transactionsRes.data || []).filter((t) => !t.voided)

  const context = {
    monthTransactions,
    liquidWalletIds,
    goals: goalsRes.data || [],
    goalTransactions: monthTransactions,
    wallets,
    debts: debtsRes.data || [],
  }

  let modelContent
  try {
    modelContent = await callOllama(buildNlQueryPrompt(question))
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err?.message
    return json({ ok: false, reason: `could not reach the model: ${reason}` }, 502)
  }

  const call = extractJsonObject(modelContent)
  if (!call) {
    return json({ ok: false, reason: 'the model did not return a usable answer' })
  }
  if (!call.function) {
    return json({ ok: false, reason: call.reason || 'no function in the list can answer that' })
  }

  const outcome = runQuery(call, context)
  return json({ ...outcome, functionCalled: call.function })
})
