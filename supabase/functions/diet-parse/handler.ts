// The diet-parse request handler, with its outside world passed in.
//
// index.ts wires the real Supabase clients and the real Claude call;
// handler.test.ts passes fakes, so every branch below (no key, not signed
// in, not the owner, a model that answers badly twice, a good answer) is
// tested without a network or a key. The shape follows analyze-meal:
// CORS to one origin, a GET health probe, the caller's JWT for reads (RLS),
// the service role only to check the pinned owner, and every failure after
// the auth checks returned as HTTP 200 with {ok: false, reason}, because
// supabase-js turns a non-2xx into an error the page cannot read.
//
// It writes nothing. The page shows the entry, the owner taps "Looks
// right", and the page logs it through log_diet_meal and
// apply_pantry_updates (048, 051) as the owner.
//
// Added for the Diet module, Phase 2 (docs/diet-module.md).
import { TEXT_PARSE_MD } from '../../../src/lib/diet/promptText.js'
import { fillPrompt, catalogText, parseUserMessage } from '../../../src/lib/diet/prompts.js'
import { loadLibraryWith } from '../_shared/library.ts'
import { matchParsed, PARSE_LIMITS } from '../../../src/lib/diet/parse.js'
import type { ParseResultT } from './schema.ts'

export const SERVICE = 'diet-parse'
export const DEFAULT_MODEL = 'claude-haiku-5-5'

/** What one model call returns, whatever SDK is behind it. */
export type ModelAnswer = {
  parsed: ParseResultT | null
  stopReason: string | null
  usage?: Record<string, unknown> | null
}

export type ModelCall = (args: { model: string; system: string; catalog: string; user: string }) => Promise<ModelAnswer>

// deno-lint-ignore no-explicit-any
type Client = any

export type Deps = {
  env: (name: string) => string | undefined
  userClient: (authHeader: string) => Client
  adminClient: () => Client
  callModel: ModelCall
  now?: () => Date
}

function corsHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    Vary: 'Origin',
  }
}

const LAGOS_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

// loadLibraryWith moved to ../_shared/library.ts in Phase 3 (diet-photo uses it
// too); re-exported here so existing imports keep working.
export { loadLibraryWith }

export function makeHandler(deps: Deps) {
  const origin = deps.env('ALLOWED_ORIGIN') || 'https://jare-mainframe.pages.dev'
  const cors = corsHeaders(origin)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  const model = deps.env('DIET_PARSE_MODEL') || DEFAULT_MODEL
  const hasKey = Boolean(deps.env('ANTHROPIC_API_KEY'))

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    // Answered without a model call, so the app can tell "deployed" from
    // "not deployed" and "no key set" before the owner types anything.
    if (req.method === 'GET') return json({ ok: true, service: SERVICE, model, providers: { anthropic: hasKey } })
    if (req.method !== 'POST') return json({ ok: false, reason: 'POST only' }, 405)

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ ok: false, reason: 'missing Authorization header' }, 401)

    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return json({ ok: false, reason: 'malformed request body' })
    }
    const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : ''
    if (!text) return json({ ok: false, reason: 'type or say what you ate' })
    if (text.length > PARSE_LIMITS.textChars) return json({ ok: false, reason: `keep it under ${PARSE_LIMITS.textChars} characters` })
    const localTime =
      typeof body?.localTime === 'string' && /^\d{2}:\d{2}$/.test(body.localTime) ? body.localTime : LAGOS_TIME.format((deps.now ?? (() => new Date()))())

    const user = deps.userClient(authHeader)
    const { data: userData, error: userError } = await user.auth.getUser()
    if (userError || !userData?.user) return json({ ok: false, reason: 'not signed in' }, 401)

    // The owner only, as in analyze-meal: RLS keeps a stray account's rows
    // apart, but nothing in RLS stops it spending the owner's model key.
    const { data: pinned } = await deps.adminClient().from('jare_owner').select('user_id').limit(1).maybeSingle()
    if (!pinned?.user_id || pinned.user_id !== userData.user.id) {
      return json({ ok: false, reason: 'this service answers its owner only' }, 403)
    }

    if (!hasKey) return json({ ok: false, reason: 'the text parser is not set up yet (no ANTHROPIC_API_KEY secret)' })

    let lib
    try {
      lib = await loadLibraryWith(user)
    } catch (err) {
      return json({ ok: false, reason: `could not read your foods: ${(err as Error).message}`.slice(0, 300) })
    }

    let system: string
    try {
      system = fillPrompt(TEXT_PARSE_MD, lib.settings)
    } catch (err) {
      return json({ ok: false, reason: (err as Error).message })
    }
    const catalog = catalogText(lib)
    const userMessage = parseUserMessage({ text, localTime })

    // One retry on an answer that does not validate, then give up for this
    // note (the build spec's rule); a refusal is not retried.
    const started = Date.now()
    const failures: string[] = []
    for (let attempt = 1; attempt <= 2; attempt++) {
      let answer: ModelAnswer
      try {
        answer = await deps.callModel({ model, system, catalog, user: userMessage })
      } catch (err) {
        failures.push(`attempt ${attempt}: ${(err as Error)?.message ?? String(err)}`)
        continue
      }
      if (answer.stopReason === 'refusal') {
        console.warn(`${SERVICE}: the model declined`, answer.usage ?? '')
        return json({ ok: false, reason: 'the model declined to read that note; log it by hand' })
      }
      if (!answer.parsed) {
        failures.push(`attempt ${attempt}: ${answer.stopReason === 'max_tokens' ? 'the answer was cut off' : 'the answer did not match the schema'}`)
        continue
      }
      const entry = matchParsed(answer.parsed, lib)
      return json({ ok: true, entry, model, attempts: attempt, usage: answer.usage ?? null, elapsedMs: Date.now() - started })
    }

    console.warn(`${SERVICE}: no usable answer:`, failures.join(' | '))
    return json({ ok: false, reason: `could not read that note: ${failures.join('; ')}`.slice(0, 300) })
  }
}
