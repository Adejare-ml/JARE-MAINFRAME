/**
 * What a natural-language money question would ask a model for, if this app
 * had somewhere to run it interactively.
 *
 * It does not, yet, and that is a deliberate, documented cut rather than an
 * oversight. Every model call in this codebase today happens from a scheduled
 * GitHub Action with a service-role key -- gmail-sync.mjs, plan-month.mjs,
 * weekly-recap.mjs -- never from the browser, which has no credential to make
 * one safely. Answering a typed question needs the opposite shape: a live
 * round trip, started by the person, answered in seconds. That is a Supabase
 * Edge Function (Deno, a new runtime this project has never deployed or
 * tested) or an equivalent always-on endpoint, and standing one up is a
 * decision with its own operational cost -- cold starts, a second place
 * secrets live, a new failure mode with no scheduled retry to fall back on --
 * that deserves to be made on purpose, not folded into a stage that was
 * asked to ship five other things.
 *
 * So this file, and src/lib/nlQuery.js next to it, ship the part that is
 * real and testable without one: the prompt a model would receive, built
 * from the same describeQueries() list runQuery() enforces, and the contract
 * both sides would honour -- the model names a function and supplies
 * arguments, nothing else. Wiring it to an actual endpoint is future work,
 * and when it happens this is the file that already says what to ask for.
 */

import { describeQueries } from './nlQuery.js'

export const NL_QUERY_SYSTEM_PROMPT = `You are answering a question about someone's own personal finances, by choosing ONE function from a fixed list and giving it arguments. You do not compute the answer yourself, and you do not have direct access to their data.

Return JSON: {"function": "...", "args": {...}}

Rules, in order of importance:

1. "function" MUST be one of the names given to you, copied EXACTLY. Not a similar name. Not a function you expect to exist.

2. "args" must contain only the arguments that function declares, with the right type for each. Omit an argument you were not given a value for rather than guessing one.

3. If no function in the list can answer the question, return {"function": null, "reason": "..."} explaining briefly why not, rather than picking the closest one.

4. You will be told the function's result separately, after it runs. Do not answer the question yourself in this response -- only choose how to answer it.`

/**
 * Build the user prompt for one question, listing exactly what runQuery()
 * will accept -- so the model is never told about a function this file does
 * not also enforce.
 *
 * @param {string} question
 * @returns {string}
 */
export function buildNlQueryPrompt(question) {
  const lines = ['FUNCTIONS YOU MAY CALL', '']

  for (const q of describeQueries()) {
    const signature = q.params.length === 0
      ? `${q.name}(no arguments)`
      : `${q.name}(${q.params.map((p) => `${p.name}: ${p.type}${p.required ? '' : ' (optional)'}`).join(', ')})`
    lines.push(`- ${signature} — ${q.description}`)
  }

  lines.push('', 'QUESTION', String(question || '').trim() || '(none given)')
  return lines.join('\n')
}
