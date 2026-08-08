/**
 * Validation of parsed transactions before they reach the database.
 *
 * The LLM path in particular returns free-form JSON: a category the app has
 * never heard of silently breaks every filter and rollup, and a `type` that
 * isn't debit/credit corrupts the monthly totals. Nothing is trusted here.
 */

import { ALL_CATEGORIES } from '../constants.js'

export const VALID_TYPES = ['debit', 'credit']
export const VALID_CONFIDENCE = ['HIGH', 'MEDIUM', 'LOW']

/** Full email bodies carry balances and account fragments and bloat every
 *  unfiltered select. Keep just enough to eyeball a mis-parse. */
export const RAW_EMAIL_MAX_CHARS = 500

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/

/**
 * @param {string} dateStr
 * @returns {boolean} true when the string is a real calendar date
 */
export function isValidDate(dateStr) {
  if (!DATE_RE.test(String(dateStr || ''))) return false
  const d = new Date(`${dateStr}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return false
  // Rejects 2026-02-31, which Date would roll forward into March.
  return d.toISOString().slice(0, 10) === dateStr
}

/**
 * Validate and clean a parsed transaction.
 *
 * Returns `{ ok: false, reason }` for records that cannot be trusted at all
 * (unknown direction, non-positive amount, impossible date) -- those are dropped
 * rather than guessed at, because a wrong direction silently corrupts totals.
 *
 * Recoverable problems are downgraded instead: an unrecognised category becomes
 * Uncategorized with LOW confidence, so it surfaces in the review queue.
 *
 * @param {object} txn
 * @returns {{ok: true, value: object, warnings: string[]} | {ok: false, reason: string}}
 */
export function validateParsedTransaction(txn) {
  if (!txn || typeof txn !== 'object') {
    return { ok: false, reason: 'not an object' }
  }

  const warnings = []

  const type = String(txn.type || '').trim().toLowerCase()
  if (!VALID_TYPES.includes(type)) {
    return { ok: false, reason: `invalid type: ${JSON.stringify(txn.type)}` }
  }

  const amount = Number(txn.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: `invalid amount: ${JSON.stringify(txn.amount)}` }
  }

  let transaction_date = txn.transaction_date
  if (!isValidDate(transaction_date)) {
    return { ok: false, reason: `invalid transaction_date: ${JSON.stringify(txn.transaction_date)}` }
  }

  let transaction_time = String(txn.transaction_time || '').trim()
  if (!TIME_RE.test(transaction_time)) {
    warnings.push(`invalid transaction_time ${JSON.stringify(txn.transaction_time)}, defaulted to 12:00:00`)
    transaction_time = '12:00:00'
  }

  let category = typeof txn.category === 'string' ? txn.category.trim() : ''
  let confidence = String(txn.confidence || 'LOW').toUpperCase()
  if (!VALID_CONFIDENCE.includes(confidence)) confidence = 'LOW'

  if (!ALL_CATEGORIES.includes(category)) {
    if (category) warnings.push(`unknown category ${JSON.stringify(category)}, fell back to Uncategorized`)
    category = 'Uncategorized'
    confidence = 'LOW'
  }

  let available_balance = null
  if (txn.available_balance != null) {
    const bal = Number(txn.available_balance)
    if (Number.isFinite(bal) && bal >= 0) {
      available_balance = bal
    } else {
      warnings.push(`invalid available_balance ${JSON.stringify(txn.available_balance)}, dropped`)
    }
  }

  const description = String(txn.description || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  const recipient = txn.recipient ? String(txn.recipient).replace(/\s+/g, ' ').trim().slice(0, 200) : null
  const rawEmail = txn.raw_email ? String(txn.raw_email).slice(0, RAW_EMAIL_MAX_CHARS) : null
  const explanation = txn.explanation
    ? String(txn.explanation).replace(/\s+/g, ' ').trim().slice(0, 300)
    : null

  return {
    ok: true,
    warnings,
    value: {
      type,
      amount: Number(amount.toFixed(2)),
      currency: txn.currency || 'NGN',
      source: String(txn.source || 'email').trim().toLowerCase(),
      category,
      description,
      recipient,
      explanation,
      available_balance,
      transaction_date,
      transaction_time,
      transaction_id: txn.transaction_id || null,
      confidence,
      // HIGH means both direction and category are settled, so the row is
      // accepted without a human ever seeing it. Anything less lands in the
      // review queue, which is the whole point: only the genuinely unsure ones
      // are worth a tap.
      reviewed: confidence === 'HIGH',
      raw_email: rawEmail,
      ...(txn.wallet_id ? { wallet_id: txn.wallet_id } : {}),
    },
  }
}

/**
 * Pull a JSON object out of an LLM response.
 *
 * Has to survive reasoning models that wrap their answer in <think> blocks and
 * chat models that wrap it in markdown fences. A greedy first-brace-to-last-brace
 * match breaks on both, so this strips the wrappers and then brace-matches for
 * the first *balanced* object, respecting string literals and escapes.
 *
 * @param {string} content
 * @returns {object|null}
 */
export function extractJsonObject(content) {
  if (!content || typeof content !== 'string') return null

  let text = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    // An unterminated reasoning block means everything before </think> never
    // arrived -- drop the opener and keep what follows.
    .replace(/^[\s\S]*?<\/think>/i, '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim()

  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }

  return null
}
