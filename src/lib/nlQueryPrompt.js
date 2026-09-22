/**
 * What the Ask page asks a model for.
 *
 * Built from the same describeQueries() list runQuery() enforces, so the
 * model is never offered a function this app will not run. The live round
 * trip is supabase/functions/ask-question/index.ts, which calls
 * buildNlQueryPrompt and hands the model's answer straight to runQuery.
 * The contract both sides honour: the model names a function and supplies
 * arguments, nothing else -- it never computes an answer itself.
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
