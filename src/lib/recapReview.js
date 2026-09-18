/**
 * Deciding which sentences of a model's weekly recap are allowed to be shown.
 *
 * The same rule as src/lib/planReview.js, applied to prose instead of a plan:
 * **a sentence that cannot cite something checkable does not get shown.** Here
 * that is stronger by one step, because planReview.js only had to check that a
 * citation was real -- a recap sentence also states numbers, and a model that
 * cites a real fact but writes the wrong figure next to it has produced
 * something that looks exactly as trustworthy as one that got it right. So
 * this file checks both: the citation must name a fact that exists, and every
 * number the sentence mentions must already be one of that fact's own numbers.
 *
 * That second check is what makes a wrong number structurally impossible to
 * ship, not just unlikely. A model cannot invent a spend figure and have it
 * pass, because nothing it writes is trusted -- only echoed back if it matches
 * something computed before the model ever saw the prompt.
 *
 * Pure, and importing nothing, so every rule here can be tested without a
 * model, a database or a network -- same discipline as planReview.js.
 */

/** Shortest and longest a sentence may be. Below, it says nothing; above, it is not a recap. */
export const MIN_SENTENCE = 10
export const MAX_SENTENCE = 220

/** Most sentences a recap may hold. A weekly recap that runs longer is a report. */
export const DEFAULT_MAX_SENTENCES = 6

/**
 * Does this citation name a real fact?
 *
 * Exact match, not fuzzy, for the same reason resolveCitation in planReview.js
 * is exact: a near-miss key is the interesting case, and it must fail. Facts
 * are computer-generated identifiers (`spent`, `category:Transport`), not
 * sentences a person typed, so there is no capitalisation latitude to give.
 *
 * @param {string} cites
 * @param {Array<{key: string}>} facts
 * @returns {{key: string, numbers: Array<number>, text: string}|null}
 */
export function resolveFactCitation(cites, facts = []) {
  const claim = typeof cites === 'string' ? cites.trim() : ''
  if (!claim) return null
  return (Array.isArray(facts) ? facts : []).find((f) => f && f.key === claim) || null
}

/** Every number-looking substring in a sentence, comma separators stripped. */
function numbersIn(text) {
  const matches = String(text || '').match(/\d[\d,]*(?:\.\d+)?/g) || []
  return matches.map((m) => Number(m.replace(/,/g, '')))
}

/**
 * Filter a model's proposed recap down to the sentences that survive scrutiny.
 *
 * Never throws, and an item that fails takes only itself with it -- the same
 * one-bad-item-doesn't-poison-the-rest guarantee reviewPlan makes. Every
 * rejection carries a reason in words, printed by the recap script, which is
 * the only place anyone will see why a proposed recap shrank.
 *
 * @param {Array<{sentence: string, cites: string}>} proposal
 * @param {Array<{key: string, numbers: Array<number>, text: string}>} facts
 * @param {{maxSentences?: number}} [options]
 * @returns {{accepted: Array<{sentence: string, cites: string}>, rejected: Array<{item: object, reason: string}>}}
 */
export function reviewRecap(proposal, facts = [], { maxSentences = DEFAULT_MAX_SENTENCES } = {}) {
  const accepted = []
  const rejected = []
  const usedKeys = new Set()

  for (const raw of Array.isArray(proposal) ? proposal : []) {
    const item = raw && typeof raw === 'object' ? raw : {}
    const sentence = typeof item.sentence === 'string' ? item.sentence.trim() : ''

    if (accepted.length >= maxSentences) {
      rejected.push({ item, reason: `already has ${maxSentences} sentences; the recap stays short` })
      continue
    }

    if (sentence.length < MIN_SENTENCE) {
      rejected.push({ item, reason: 'the sentence is too short to say anything' })
      continue
    }
    if (sentence.length > MAX_SENTENCE) {
      rejected.push({ item, reason: `the sentence runs to ${sentence.length} characters; it has to fit on a card` })
      continue
    }

    const fact = resolveFactCitation(item.cites, facts)
    if (!fact) {
      // The rule the whole file exists for, stated exactly as intended -- this
      // is the rejection that will happen most and the one most likely to be
      // mistaken for a bug rather than the filter working.
      rejected.push({
        item,
        reason: `cites "${item.cites ?? '(nothing)'}", which is not one of this week's facts`,
      })
      continue
    }

    // One sentence per fact. Two sentences about "spent" and none about the
    // streak is a model that lost track of what it was given, and silently
    // keeping the first would hide that -- same reasoning as reviewPlan's
    // one-focus-per-week rule.
    if (usedKeys.has(fact.key)) {
      rejected.push({ item, reason: `${fact.key} already has a sentence` })
      continue
    }

    const authorized = new Set((fact.numbers || []).map((n) => Number(n)))
    const bogus = numbersIn(sentence).find((n) => !authorized.has(n))
    if (bogus !== undefined) {
      // The check this file exists for, beyond what planReview.js needed: a
      // citation can be real while the number sitting next to it is invented.
      rejected.push({
        item,
        reason: `mentions ${bogus}, which is not one of the numbers ${fact.key} actually has`,
      })
      continue
    }

    usedKeys.add(fact.key)
    accepted.push({ sentence, cites: fact.key })
  }

  return { accepted, rejected }
}
