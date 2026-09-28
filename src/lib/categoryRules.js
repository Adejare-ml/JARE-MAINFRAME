/**
 * Teaching the app a payee from the review queue.
 *
 * Category rules (migration 020, Settings → Category Rules) are checked
 * first by everything that files a transaction: the retired sync, and now
 * ingest_alert_transaction (034), where a rule also outranks the own-account
 * check (036). Until this existed the only way to make one was to leave the
 * ledger, open Settings, and type the payee's name again. The review queue
 * is where the decision is actually made -- "this ₦2,100 to Nandip is
 * Family Support" -- and the same payee comes back every few days, so the
 * decision is offered there: one checkbox, one rule, and every other row
 * from that payee still waiting gets the answer now.
 *
 * Pure: a row and a category in, a rule out. The writes live in
 * Transactions.jsx.
 */

/** Rules made here always key on the payee; a description is the bank's
 *  narration and the model's paraphrase, neither stable enough to match on. */
export const RULE_FIELD = 'recipient'

/** What the rule stores: whitespace collapsed and trimmed, case kept, the
 *  same normalisation ingest_alert_transaction applies to the recipient. */
export function normalizePayee(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The rule a "file this payee as <category> from now on" tap creates, or
 * null when there is nothing to key on: no recipient (a card purchase
 * names nobody), or Uncategorized, which is not a decision.
 *
 * @param {{recipient?: string|null}|null} txn
 * @param {string} category
 * @returns {{trigger_field: string, trigger_value: string, action_category: string, priority: number}|null}
 */
export function ruleFromTransaction(txn, category) {
  const trigger_value = normalizePayee(txn?.recipient)
  const action_category = normalizePayee(category)
  if (!trigger_value || !action_category || action_category === 'Uncategorized') return null
  return { trigger_field: RULE_FIELD, trigger_value, action_category, priority: 0 }
}

/**
 * An existing rule this one would duplicate: same field, same value ignoring
 * case and spacing. The match is updated rather than a twin inserted, so
 * changing your mind about a payee never leaves two rules racing on
 * priority.
 *
 * @param {Array<{id?: string, trigger_field: string, trigger_value: string}>} rules
 * @param {{trigger_field: string, trigger_value: string}|null} rule
 */
export function findMatchingRule(rules, rule) {
  if (!rule) return null
  const key = normalizePayee(rule.trigger_value).toLowerCase()
  return (
    (rules || []).find(
      (r) => r && r.trigger_field === rule.trigger_field && normalizePayee(r.trigger_value).toLowerCase() === key,
    ) || null
  )
}

/**
 * The payee as a PostgREST `ilike` pattern fragment. `%` and `_` are
 * wildcards there, so a payee named "50% OFF LTD" has to be escaped before
 * it is wrapped in `%…%` for the same case-insensitive substring match the
 * ingest function uses.
 */
export function likeLiteral(value) {
  return normalizePayee(value).replace(/[\\%_]/g, (c) => '\\' + c)
}

/** What a re-filed row says about itself in the queue, in place of the
 *  ingest function's "pick the category" explanation. */
export function ruleExplanation(rule) {
  return `Filed by your rule: ${rule.trigger_field} contains "${rule.trigger_value}"`
}
