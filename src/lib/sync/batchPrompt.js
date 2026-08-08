import { ALL_CATEGORIES } from '../constants.js'
import { coerceCategory } from './categorize.js'

/**
 * Building the categorization request and reading its answer.
 *
 * Pure, so the prompt shape and every way a model can mangle its response are
 * testable without a network. The provider calls themselves live in
 * scripts/llm.mjs.
 */

/** Transactions per request. Ten keeps the response inside the token budget
 *  while cutting call count by an order of magnitude against one-per-email. */
export const BATCH_SIZE = 10

/** How many past corrections to show the model. Enough to convey a habit,
 *  small enough that the prompt stays cheap. */
export const MAX_CORRECTION_EXAMPLES = 30

/** Response tokens to allow. Each result is ~40 tokens; this leaves headroom. */
export const BATCH_MAX_TOKENS = 1200

export const CATEGORIZE_SYSTEM_PROMPT = `You categorize Nigerian bank and fintech transactions.

You receive a numbered list of transactions. For EACH one, return an entry with:
  "id"          the exact id given to you
  "category"    one of: ${ALL_CATEGORIES.join(' | ')}
  "explanation" ONE short sentence describing what this transaction appears to be
  "confidence"  "HIGH" or "LOW"

Return ONLY this JSON object, nothing else:
{"results": [{"id": "...", "category": "...", "explanation": "...", "confidence": "HIGH"}]}

Rules:
- "category" must be copied EXACTLY from the list above. Never invent one.
  If nothing fits well, use "Uncategorized" and set confidence "LOW".
- "explanation" must be specific and drawn from the transaction's own details --
  name the counterparty or the merchant where you can. Good: "Transfer received
  from Nandip Mamtur Ladong via Opay." Bad: "A financial transaction."
- "confidence" is "HIGH" only when the category is genuinely clear from the
  details. If you are picking the least-bad option, say "LOW".
- Return exactly one entry per transaction given, using the same ids.`

/**
 * Render past corrections as few-shot examples.
 *
 * @param {Array<{recipient?: string, description_snippet?: string, corrected_category: string}>} corrections
 * @returns {string} empty string when there is nothing to show
 */
export function formatCorrections(corrections) {
  const usable = (corrections || [])
    .filter((c) => c?.corrected_category && (c.recipient || c.description_snippet))
    .slice(0, MAX_CORRECTION_EXAMPLES)

  if (usable.length === 0) return ''

  const lines = usable.map((c) => {
    const subject = c.recipient || c.description_snippet
    return `- "${String(subject).slice(0, 60)}" -> ${c.corrected_category}`
  })

  return `\nThis user has corrected your categories before. Match these habits:\n${lines.join('\n')}\n`
}

/**
 * Render the transactions to be categorized.
 *
 * Deliberately a compact summary rather than the raw email: the model needs
 * counterparty, amount and direction to categorize, and sending ten full email
 * bodies would blow the context for no gain.
 *
 * @param {Array<{id: string, type: string, amount: number, description?: string, recipient?: string, walletName?: string}>} items
 * @returns {string}
 */
export function formatBatch(items) {
  return (items || [])
    .map((item) => {
      const parts = [
        `id: ${item.id}`,
        `${item.type === 'credit' ? 'money in' : 'money out'} ${item.amount}`,
      ]
      if (item.walletName) parts.push(`via ${item.walletName}`)
      if (item.recipient) parts.push(`other party: ${item.recipient}`)
      if (item.description) parts.push(`narration: ${String(item.description).slice(0, 200)}`)
      return `- ${parts.join(' | ')}`
    })
    .join('\n')
}

/**
 * @param {Array} items
 * @param {Array} corrections
 * @returns {string}
 */
export function buildBatchPrompt(items, corrections) {
  return `${formatCorrections(corrections)}
Categorize these ${items.length} transaction(s):

${formatBatch(items)}`
}

/**
 * Turn a model response into one result per requested item.
 *
 * Never throws and never returns a short array: every id asked about gets an
 * answer, and anything the model omitted, invented or malformed becomes
 * Uncategorized at LOW confidence. One bad entry cannot cost the other nine
 * their categories, and a wholly failed response degrades to a review queue
 * rather than a failed sync.
 *
 * @param {object|null} parsed - the JSON object returned by the model
 * @param {Array<{id: string}>} items - what was asked about
 * @returns {Array<{id: string, category: string, explanation: string|null, confidence: 'HIGH'|'LOW', known: boolean}>}
 */
export function parseBatchResponse(parsed, items) {
  const byId = new Map()

  // Tolerate a bare array as well as {results: [...]}: models produce both.
  const results = Array.isArray(parsed) ? parsed : parsed?.results
  if (Array.isArray(results)) {
    for (const entry of results) {
      if (entry && entry.id != null) byId.set(String(entry.id), entry)
    }
  }

  return (items || []).map((item) => {
    const entry = byId.get(String(item.id))
    if (!entry) {
      return {
        id: item.id,
        category: 'Uncategorized',
        explanation: null,
        confidence: 'LOW',
        known: false,
      }
    }

    const { category, known } = coerceCategory(entry.category)
    const claimed = String(entry.confidence || '').toUpperCase()
    // An invented category cannot be HIGH confidence whatever the model says.
    const confidence = claimed === 'HIGH' && known ? 'HIGH' : 'LOW'

    const explanation =
      typeof entry.explanation === 'string' && entry.explanation.trim()
        ? entry.explanation.trim().slice(0, 300)
        : null

    return { id: item.id, category, explanation, confidence, known }
  })
}

/**
 * Split a list into fixed-size batches.
 * @param {Array} items
 * @param {number} [size]
 * @returns {Array<Array>}
 */
export function chunk(items, size = BATCH_SIZE) {
  const out = []
  for (let i = 0; i < (items || []).length; i += size) out.push(items.slice(i, i + size))
  return out
}
