// The diet-coach request handler (Diet module, Phase 4), with its outside
// world passed in so handler_test.ts runs every branch without a network.
//
//   verdict  {meal_id}  after a meal logged from a note, a voice note or a
//            photo. Saved and hand-picked meals have known numbers, so their
//            verdict is computed in code and no model is called (the browser
//            does not ask for them; asked anyway, this answers from code).
//            The coach's verdict is kept when it agrees with the rule in
//            src/lib/diet/verdict.js; otherwise the rule's stands. Stored on
//            the meal (verdict, reason, coach).
//   next     {}         "What should I eat next?": what is left today, the
//            time, the last 7 days and the pantry, through the same prompt
//            with meal null. Nothing is stored.
//
// Every read and write uses the caller's own client, so RLS applies; the
// service role is used only to check the pinned owner. Failures after the
// auth checks are HTTP 200 with {ok: false, reason}.
import { COACH_MD } from '../../../src/lib/diet/promptText.js'
import { fillPrompt } from '../../../src/lib/diet/prompts.js'
import { coachInput, checkCoachAnswer, needsCoach, patternFlag } from '../../../src/lib/diet/coach.js'
import { mealVerdict } from '../../../src/lib/diet/verdict.js'
import { localDay, addDays } from '../../../src/lib/diet/totals.js'
import { CoachAnswer, type CoachAnswerT } from './schema.ts'

export const SERVICE = 'diet-coach'
export const DEFAULT_MODEL = 'claude-haiku-5-5'

export type CoachCall = (args: { model: string; system: string; user: string }) => Promise<{ answer: unknown; stopReason?: string | null }>

// deno-lint-ignore no-explicit-any
type Client = any

export type Deps = {
  env: (name: string) => string | undefined
  userClient: (authHeader: string) => Client
  adminClient: () => Client
  callModel: CoachCall
  now?: () => Date
}

const LAGOS = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

async function ask(deps: Deps, model: string, system: string, user: string): Promise<{ ok: true; answer: CoachAnswerT } | { ok: false; reason: string }> {
  const reasons: string[] = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const reply = await deps.callModel({ model, system, user })
      if (reply.stopReason === 'refusal') return { ok: false, reason: 'the coach declined' }
      const checked = CoachAnswer.safeParse(reply.answer)
      if (checked.success) return { ok: true, answer: checked.data }
      reasons.push(`attempt ${attempt}: the answer did not match the schema`)
    } catch (err) {
      return { ok: false, reason: `the coach could not be reached: ${(err as Error)?.message ?? err}`.slice(0, 200) }
    }
  }
  return { ok: false, reason: reasons.join('; ') }
}

export function makeHandler(deps: Deps) {
  const origin = deps.env('ALLOWED_ORIGIN') || 'https://jare-mainframe.pages.dev'
  const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', Vary: 'Origin' }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  const model = deps.env('DIET_COACH_MODEL') || DEFAULT_MODEL
  const hasKey = Boolean(deps.env('ANTHROPIC_API_KEY'))
  const now = deps.now ?? (() => new Date())

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
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

    const user = deps.userClient(authHeader)
    const { data: userData, error: userError } = await user.auth.getUser()
    if (userError || !userData?.user) return json({ ok: false, reason: 'not signed in' }, 401)
    const { data: pinned } = await deps.adminClient().from('jare_owner').select('user_id').limit(1).maybeSingle()
    if (!pinned?.user_id || pinned.user_id !== userData.user.id) return json({ ok: false, reason: 'this service answers its owner only' }, 403)

    const action = body.action === 'next' ? 'next' : body.action === 'verdict' ? 'verdict' : null
    if (!action) return json({ ok: false, reason: 'action must be verdict or next' })

    // The day: the meal's own day for a verdict, today in Lagos for "what next".
    let meal = null
    if (action === 'verdict') {
      const { data } = await user.from('meal_logs').select('id, eaten_on, eaten_at, meal_slot, source, kcal, protein_g').eq('id', String(body.meal_id ?? '')).maybeSingle()
      if (!data) return json({ ok: false, reason: 'no such meal' })
      meal = data
    }
    const day = meal?.eaten_on ?? localDay(now())
    const [settingsRes, logsRes, recentRes, pantryRes] = await Promise.all([
      user.from('diet_settings').select('*').maybeSingle(),
      user.from('meal_logs').select('id, eaten_at, meal_slot, kcal, protein_g, meal_items(name)').eq('eaten_on', day).order('eaten_at'),
      user.from('diet_daily_totals').select('eaten_on, kcal, protein_g').gte('eaten_on', addDays(day, -7)).lte('eaten_on', addDays(day, -1)).order('eaten_on'),
      user.from('pantry_items').select('name, quantity, unit, finished').eq('finished', false).limit(50),
    ])
    for (const r of [settingsRes, logsRes, recentRes, pantryRes]) if (r.error) return json({ ok: false, reason: `could not read your diet: ${r.error.message}` })
    const settings = settingsRes.data
    const todayLogs = logsRes.data || []
    const recent = recentRes.data || []
    const pantry = pantryRes.data || []

    let code = null
    if (meal) {
      code = mealVerdict({ settings, slot: meal.meal_slot, meal: { kcal: meal.kcal, protein_g: meal.protein_g }, earlier: todayLogs.filter((l: { id: string }) => l.id !== meal.id) })
      if (!needsCoach(meal)) return json({ ok: true, verdict: code.verdict, reason: code.reason, from: 'code' })
    }
    if (!hasKey) return json({ ok: false, reason: 'the coach is not set up yet (no ANTHROPIC_API_KEY secret)', verdict: code?.verdict ?? null })

    const input = coachInput({ settings, todayLogs, recent, mealId: meal?.id ?? null, localTime: meal ? LAGOS.format(new Date(meal.eaten_at)) : LAGOS.format(now()), pantry })
    const system = fillPrompt(COACH_MD, settings)
    const res = await ask(deps, model, system, JSON.stringify(input))
    if (!res.ok) {
      console.warn(`${SERVICE}: ${res.reason}`)
      return json({ ok: false, reason: res.reason, verdict: code?.verdict ?? null })
    }
    const checked = checkCoachAnswer(res.answer, { hasMeal: Boolean(meal), code, settings })
    const flag = checked.flag ?? patternFlag(recent, settings)

    if (meal) {
      const { error } = await user
        .from('meal_logs')
        .update({
          verdict: checked.verdict,
          reason: checked.reason,
          coach: { verdict: res.answer.verdict, reason: res.answer.reason, flag: checked.flag, agreed: checked.agreed, model, at: now().toISOString() },
        })
        .eq('id', meal.id)
      if (error) return json({ ok: false, reason: `could not save the verdict: ${error.message}` })
      return json({ ok: true, verdict: checked.verdict, reason: checked.reason, agreed: checked.agreed, flag, from: 'coach' })
    }
    return json({ ok: true, reason: checked.reason, next_options: checked.next_options, flag })
  }
}
