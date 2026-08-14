/**
 * What the planner asks for, and how it asks.
 *
 * Kept out of scripts/ so the prompt is testable and reviewable like anything
 * else. `src/lib/sync/batchPrompt.js` is the precedent and the reason: the
 * categorization prompt is the one prompt in this codebase with a proven hit
 * rate, and it earned that by being a file with tests rather than a template
 * literal buried in a script.
 *
 * Two things it borrows from that prompt, both load-bearing:
 *
 *   The model copies from a list rather than inventing. Categories are copied
 *   verbatim there; citations are copied verbatim here. A model asked to invent
 *   an identifier invents a plausible one, and a plausible-but-wrong path is
 *   exactly what src/lib/planReview.js exists to catch -- so the prompt is
 *   built to make the correct behaviour the easy one.
 *
 *   It is told what "I don't know" looks like. Without an explicit way to
 *   decline, a model asked for five weeks of plan produces five weeks of plan,
 *   and the last two are filler. Filler that cites a real path passes review,
 *   which makes this the one failure the citation rule cannot catch on its own.
 */

export const PLAN_SYSTEM_PROMPT = `You are planning one month of engineering work for a solo developer on their own project.

You will be given:
- the goal for the month, in the developer's own words
- facts about their repository: file paths, and which have no test file
- gaps they logged themselves after leaning on an AI agent for something they did not understand

Return JSON: {"weeks": [{"week": 1, "focus": "...", "cites": "...", "reason": "..."}]}

Rules, in order of importance:

1. Every item MUST set "cites" to a repository path or a gap topic, copied
   EXACTLY from the lists you are given. Not a similar path. Not a path you
   expect to exist. If you cannot cite something from those lists, do not
   produce the item at all.

2. Prefer gaps to paths. A gap is something the developer has already told you
   they do not understand; a path is only a file. Work that closes a gap is
   worth more than work that touches a file.

3. Return FEWER weeks rather than filling every week. An empty week is an
   honest answer and the developer will plan it themselves. A week of filler
   costs them a week.

4. "focus" is one concrete sentence naming what to do, under 160 characters.
   "Add tests for src/lib/constants.js" is a focus. "Improve code quality" is
   not: it could be written about any repository on any month.

5. "reason" is one short sentence on why this, now. It is shown to the
   developer when they approve or discard the plan.

6. Do not mention commit counts, deadlines or how much to do. Those are
   computed from the goal and you would only contradict them.

If nothing in the inputs supports a plan, return {"weeks": []}.`

/** Most gaps shown. A long list buries the recent ones, which are the live ones. */
export const MAX_GAPS_SHOWN = 12

/**
 * Build the user prompt for one monthly goal.
 *
 * @param {{goal: object, repoText: string, gaps: Array<{topic: string, note?: string}>, weeks: number}} input
 * @returns {string}
 */
export function buildPlanPrompt({ goal, repoText, gaps = [], weeks = 4 }) {
  const lines = [
    `Goal for the month: ${goal?.title || '(untitled)'}`,
    '',
    `This month has ${weeks} week${weeks === 1 ? '' : 's'} to plan. Number them 1 to ${weeks}.`,
    '',
    'REPOSITORY',
    repoText || '(no repository information available)',
    '',
    'GAPS THEY LOGGED',
  ]

  const open = gaps.slice(0, MAX_GAPS_SHOWN)
  if (open.length === 0) {
    // Said explicitly rather than left blank. An empty section reads to a model
    // as an omission it should compensate for; a stated absence reads as a
    // fact, and this one matters -- it is the difference between "they have no
    // gaps" and "the gaps did not load".
    lines.push('(none logged — plan from the repository alone)')
  } else {
    for (const gap of open) {
      const note = gap.note ? ` — ${String(gap.note).slice(0, 160)}` : ''
      lines.push(`- ${gap.topic}${note}`)
    }
  }

  lines.push(
    '',
    'Cite by copying a path or a gap topic exactly as written above.',
  )

  return lines.join('\n')
}
