import { ALL_CATEGORIES } from '../constants.js'

/**
 * Category rules that outrank the model.
 *
 * These are facts about the account, not judgements about the email: money
 * arriving in a PiggyVest wallet is a savings deposit whatever the narration
 * says, and a stamp duty line is a bank charge. Applying them after the LLM
 * keeps the model's job to the genuinely ambiguous middle.
 */

/** Wallet type → what an inflow to it means. */
const INFLOW_BY_WALLET_TYPE = {
  savings: 'Savings',
  investment: 'Investment',
}

/**
 * Narrations that are charges rather than spending. Matched case-insensitively
 * against description and recipient.
 */
const CHARGE_PATTERNS = [
  /stamp\s*duty/i,
  /\bsms\s*(alert|notification)?\s*(charge|fee)/i,
  /\bvat\b/i,
  /maintenance\s*(charge|fee)/i,
  /account\s*maintenance/i,
  /(commission|service|transaction|transfer)\s*(charge|fee)/i,
  /\bcot\b/i,
]

const ATM_PATTERNS = [
  /\batm\b/i,
  /cash\s*withdrawal/i,
  /\bwithdrawal\s*at\b/i,
]

const matchesAny = (patterns, text) => patterns.some((re) => re.test(text))

/**
 * Check a transaction against the user's own category_rules rows (migration
 * 020), in priority order.
 *
 * Substring matching, case-insensitive, on exactly the field the rule names
 * -- not the combined description+recipient haystack CHARGE_PATTERNS uses,
 * because a rule the user wrote for "recipient" should not also fire on a
 * coincidental word in the description.
 *
 * @param {object} txn
 * @param {Array<{trigger_field: string, trigger_value: string, action_category: string, priority?: number}>} rules
 * @returns {{category: string, reason: string} | null}
 */
function matchCategoryRule(txn, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null

  const fields = { description: txn?.description || '', recipient: txn?.recipient || '' }
  const sorted = rules.filter(Boolean).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))

  for (const rule of sorted) {
    const haystack = fields[rule?.trigger_field]
    const needle = (rule?.trigger_value || '').trim()
    if (!haystack || !needle) continue
    if (haystack.toLowerCase().includes(needle.toLowerCase())) {
      return {
        category: rule.action_category,
        reason: `rule: ${rule.trigger_field} contains "${needle}"`,
      }
    }
  }

  return null
}

/**
 * Apply the deterministic overrides.
 *
 * @param {object} txn - a parsed transaction ({type, category, description, recipient})
 * @param {object|null} wallet - the wallet it belongs to
 * @param {Array<object>} [rules] - the user's own category_rules rows, checked
 *   first -- more specific than any structural fact below, since the user
 *   wrote each one for a merchant or narration they personally recognise.
 * @returns {{category: string, reason: string|null}} the category to store, and
 *   why it was overridden (null when the model's answer stood)
 */
export function applyCategoryOverrides(txn, wallet, rules = []) {
  const original = txn?.category || 'Uncategorized'
  const haystack = `${txn?.description || ''} ${txn?.recipient || ''}`

  const ruleMatch = matchCategoryRule(txn, rules)
  if (ruleMatch) return ruleMatch

  // Charges first: a stamp duty debit on a savings wallet is still a charge.
  if (matchesAny(CHARGE_PATTERNS, haystack)) {
    return { category: 'Bank Charges', reason: 'bank charge narration' }
  }

  if (matchesAny(ATM_PATTERNS, haystack) && txn?.type === 'debit') {
    // Not spending: the money moved to your pocket. Counted as a transfer.
    return { category: 'Cash Withdrawal', reason: 'ATM withdrawal' }
  }

  const inflowCategory = INFLOW_BY_WALLET_TYPE[wallet?.type]
  if (inflowCategory && txn?.type === 'credit') {
    return { category: inflowCategory, reason: `inflow to a ${wallet.type} wallet` }
  }

  return { category: original, reason: null }
}

/**
 * Coerce a model-supplied category to one the app can display.
 *
 * `validateParsedTransaction` does this too, but doing it here as well means
 * the batch layer can report *which* items the model got wrong, rather than
 * silently downgrading them one layer further down.
 *
 * @param {string} category
 * @returns {{category: string, known: boolean}}
 */
export function coerceCategory(category) {
  const trimmed = typeof category === 'string' ? category.trim() : ''
  if (ALL_CATEGORIES.includes(trimmed)) return { category: trimmed, known: true }

  // A case-only mismatch is the model being sloppy, not wrong.
  const caseInsensitive = ALL_CATEGORIES.find(
    (c) => c.toLowerCase() === trimmed.toLowerCase(),
  )
  if (caseInsensitive) return { category: caseInsensitive, known: true }

  return { category: 'Uncategorized', known: false }
}

/**
 * Final confidence for a transaction, given what each layer concluded.
 *
 * HIGH means both halves are settled: the direction is known (from an explicit
 * bank label or from balance arithmetic) AND the category is a real one the
 * model was confident about. Anything less goes to the review queue, because a
 * confidently-filed transaction pointing the wrong way is worse than an
 * obviously unsure one.
 *
 * @param {{directionConfidence?: string, categoryConfidence?: string, categoryKnown?: boolean}} parts
 * @returns {'HIGH'|'LOW'}
 */
export function combineConfidence({ directionConfidence, categoryConfidence, categoryKnown }) {
  const directionSure = directionConfidence === 'HIGH'
  const categorySure = categoryConfidence === 'HIGH' && categoryKnown !== false
  return directionSure && categorySure ? 'HIGH' : 'LOW'
}
