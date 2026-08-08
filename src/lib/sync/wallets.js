/**
 * Mapping alert senders to wallets, and deciding how each wallet's emails get
 * parsed.
 *
 * Parse strategy exists because rule-based direction detection is impossible for
 * some providers. Opay uses the word "transfer" for money in *and* money out, so
 * any keyword rule mislabels roughly half of them. Those wallets are marked
 * 'llm' and skip the rules entirely.
 */

export const PARSE_STRATEGIES = ['auto', 'rules', 'llm']
export const DEFAULT_PARSE_STRATEGY = 'auto'

/**
 * Providers whose alerts cannot be direction-detected by rules. Used only to
 * seed sensible defaults for a wallet that has no explicit strategy set.
 */
const LLM_REQUIRED_HINTS = ['opay', 'piggyvest']

/**
 * @param {object} wallet
 * @returns {'auto'|'rules'|'llm'}
 */
export function getParseStrategy(wallet) {
  const explicit = String(wallet?.parse_strategy || '').trim().toLowerCase()
  if (PARSE_STRATEGIES.includes(explicit)) return explicit

  // No column value yet (migration not run, or wallet added before the column
  // existed) -- infer from the provider so Opay isn't silently mislabelled.
  const haystack = `${wallet?.name || ''} ${wallet?.alert_sender || ''}`.toLowerCase()
  if (LLM_REQUIRED_HINTS.some((hint) => haystack.includes(hint))) return 'llm'

  return DEFAULT_PARSE_STRATEGY
}

import { getDomain } from './email.js'

/**
 * Build lookup structures from the wallets table. Senders are data, not
 * hardcoded constants, so adding a bank is a Settings edit rather than a deploy.
 *
 * @param {object[]} wallets
 * @returns {{senders: string[], byAddress: Map<string, object>, byDomain: Map<string, object>, byId: Map<string, object>}}
 */
export function buildWalletIndex(wallets) {
  const byAddress = new Map()
  const byDomain = new Map()
  // Every wallet, active or not -- callers look up a wallet they already
  // matched, which is a different question from which senders to search.
  const byId = new Map((wallets || []).map((w) => [w.id, w]))
  const senders = []

  for (const w of wallets || []) {
    if (w.is_active === false) continue
    if (!w.alert_sender) continue

    const sender = String(w.alert_sender).trim().toLowerCase()
    if (!sender) continue

    byAddress.set(sender, w)
    senders.push(sender)

    // First wallet wins the domain, so a precise address match is never
    // overridden by a later wallet sharing the same bank domain.
    const domain = getDomain(sender)
    if (domain && !byDomain.has(domain)) byDomain.set(domain, w)
  }

  return { senders, byAddress, byDomain, byId }
}

/**
 * Resolve which wallet an email belongs to: exact sender address first, then
 * the sending domain.
 *
 * @param {string} senderEmail
 * @param {{byAddress: Map<string, object>, byDomain: Map<string, object>}} index
 * @returns {object|null}
 */
export function matchWallet(senderEmail, index) {
  const address = String(senderEmail || '').trim().toLowerCase()
  if (!address) return null
  return index.byAddress.get(address) || index.byDomain.get(getDomain(address)) || null
}

/**
 * Restrict a slug to characters that are safe as half of a dedup key and as a
 * literal inside a PostgREST `.or()` filter, where a comma would split the
 * expression and a dot or parenthesis would silently change its meaning.
 *
 * @param {string} value
 * @returns {string}
 */
export function sanitizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

/**
 * The `source` half of a transaction's dedup key.
 *
 * Reads the wallet's immutable `source_slug`, never its display name. The name
 * is user-editable in Settings, so deriving the key from it meant renaming
 * "GTBank" to "GT Bank" changed the key on every future alert and the next sync
 * re-inserted the whole window as new rows.
 *
 * `source_slug` is written once by the migration -- seeded from the source
 * already dominant in that wallet's existing transactions, so history keeps its
 * key -- and is never rewritten afterwards.
 *
 * The name fallback exists only for the window before the migration runs. It is
 * why this returns the same value the old code did rather than something safer:
 * changing it would itself re-key everything.
 *
 * @param {object|null} wallet
 * @returns {string}
 */
export function walletSource(wallet) {
  if (wallet?.source_slug) return sanitizeSlug(wallet.source_slug)
  if (!wallet?.name) return 'email'
  return sanitizeSlug(wallet.name)
}
