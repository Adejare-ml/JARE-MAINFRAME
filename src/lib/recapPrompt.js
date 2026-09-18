/**
 * What the weekly recap asks for, and what it is allowed to ask about.
 *
 * The direct extension of src/lib/planPrompt.js's rule to a second surface: the
 * model is given facts it did not compute and may only turn them into prose. It
 * never sees a raw transaction and never does arithmetic -- every number in
 * every fact below was already produced by summarizeMonth/compareWeeks
 * (src/lib/weekreview.js), the same functions WeekReview.jsx renders from, so
 * a recap sentence and the card sitting above it can never disagree.
 *
 * Facts are `{key, numbers, text}`: `key` is what a sentence must cite,
 * `numbers` is the closed set of figures a sentence about that fact is allowed
 * to mention, and `text` is the sentence already written in case the model has
 * nothing to add. src/lib/recapReview.js is the other half -- it rejects a
 * sentence that cites the wrong key or mentions a number `numbers` does not
 * contain.
 */

import { formatNaira, formatGoalAmount } from './formatters.js'

export const RECAP_SYSTEM_PROMPT = `You are turning already-computed facts about one week of someone's personal finances into a short, honest recap.

You will be given a list of facts. Each has a key and a line of text stating it, with every number already worked out.

Return JSON: {"sentences": [{"sentence": "...", "cites": "..."}]}

Rules, in order of importance:

1. Every sentence MUST set "cites" to exactly one fact key, copied EXACTLY as given. Not a similar key. Not a key you expect to exist.

2. Every number your sentence mentions MUST be one already given for the fact you cited, written with the same digits. Do not compute a new number, round differently, or add a figure that was not given to you.

3. At most one sentence per fact, and stop once you have covered the facts worth mentioning. An empty week -- nothing to say -- is a fine answer.

4. Write like a person telling you about your own week, not a report. Short, plain sentences, no more than one idea each.

5. Do not add advice, blame, or a reason you were not told. State what happened; nothing more.

If nothing in the facts is worth a sentence, return {"sentences": []}.`

/** Facts folded into "Other" or dropped rather than crowding the prompt. */
export const MAX_CATEGORY_FACTS = 3

/** Weekly goals worth a sentence. More than this is not a recap anymore. */
export const MAX_GOAL_FACTS = 3

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

function pctOf(share) {
  return share == null ? null : Math.abs(Math.round(share * 100))
}

/**
 * Turn what compareWeeks/currentStreak already computed into citable facts.
 *
 * @param {object} input
 * @param {{spent: object, income: object, movedAside: object, byCategory: Array<{category: string, total: number}>}} input.comparison - compareWeeks() output
 * @param {number} [input.streak] - currentStreak() output
 * @param {Array<{id: string, title: string, metric?: string, measured: boolean, done: number, target: number}>} [input.weeklyGoals] - this week's weekly goals, each already run through goalProgress()
 * @returns {Array<{key: string, numbers: Array<number>, text: string}>}
 */
export function buildWeekFacts({ comparison, streak = 0, weeklyGoals = [] } = {}) {
  const facts = []

  if (comparison?.spent) {
    const now = round2(comparison.spent.now)
    const before = round2(comparison.spent.before)
    const numbers = [now]
    let text = `Spent ${formatNaira(now)} this week.`
    if (before > 0) {
      const p = pctOf(comparison.spent.share)
      numbers.push(before)
      if (p != null) numbers.push(p)
      const dir = now >= before ? 'up' : 'down'
      text = `Spent ${formatNaira(now)} this week, ${dir} ${p}% from ${formatNaira(before)} last week.`
    }
    facts.push({ key: 'spent', numbers, text })
  }

  if (comparison?.income) {
    const now = round2(comparison.income.now)
    const before = round2(comparison.income.before)
    const numbers = [now]
    let text = `Took in ${formatNaira(now)} this week.`
    if (before > 0) {
      const p = pctOf(comparison.income.share)
      numbers.push(before)
      if (p != null) numbers.push(p)
      const dir = now >= before ? 'up' : 'down'
      text = `Took in ${formatNaira(now)} this week, ${dir} ${p}% from ${formatNaira(before)} last week.`
    }
    facts.push({ key: 'income', numbers, text })
  }

  // Only worth a sentence when something actually moved -- a zero-value fact
  // that reads "moved ₦0.00 aside" is filler no different from what the
  // review step exists to catch, just written by this file instead.
  const movedNow = round2(comparison?.movedAside?.now)
  if (movedNow > 0) {
    facts.push({
      key: 'movedAside',
      numbers: [movedNow],
      text: `Moved ${formatNaira(movedNow)} aside into savings or goals this week.`,
    })
  }

  for (const cat of (comparison?.byCategory || []).slice(0, MAX_CATEGORY_FACTS)) {
    const total = round2(cat?.total)
    if (total <= 0) continue
    facts.push({
      key: `category:${cat.category}`,
      numbers: [total],
      text: `${cat.category} came to ${formatNaira(total)} this week.`,
    })
  }

  if (streak >= 1) {
    facts.push({
      key: 'streak',
      numbers: [streak],
      text: `${streak} day${streak === 1 ? '' : 's'} logged in a row.`,
    })
  }

  // Only measured goals: a manual weekly target has no figure to cite, and a
  // fact with an empty numbers array would accept any number a model wrote.
  for (const goal of (weeklyGoals || []).filter((g) => g?.measured).slice(0, MAX_GOAL_FACTS)) {
    const done = round2(goal.done)
    const target = round2(goal.target)
    facts.push({
      key: `goal:${goal.id}`,
      numbers: [done, target],
      text: `"${goal.title}" — ${formatGoalAmount(done, goal.metric)} of ${formatGoalAmount(target, goal.metric)}.`,
    })
  }

  return facts
}

/**
 * Build the user prompt from a week's facts.
 *
 * @param {Array<{key: string, text: string}>} facts
 * @returns {string}
 */
export function buildRecapPrompt(facts = []) {
  const lines = ['FACTS', '']

  if (!facts || facts.length === 0) {
    // Said explicitly, matching buildPlanPrompt's empty-gaps line: a blank
    // section reads to a model as an omission to compensate for, and this
    // absence is itself the fact -- a week with nothing measurable in it.
    lines.push('(none — nothing measurable happened this week)')
  } else {
    for (const fact of facts) {
      lines.push(`- ${fact.key}: ${fact.text}`)
    }
  }

  lines.push('', 'Cite by copying a key exactly as written above.')
  return lines.join('\n')
}
