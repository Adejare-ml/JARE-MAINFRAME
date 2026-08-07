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

/**
 * @param {string} email
 * @returns {string} domain part, lowercased
 */
function domainOf(email) {
  const at = String(email || '').lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : ''
}

/**
 * Build lookup structures from the wallets table. Senders are data, not
 * hardcoded constants, so adding a bank is a Settings edit rather than a deploy.
 *
 * @param {object[]} wallets
 * @returns {{senders: string[], byAddress: Map<string, object>, byDomain: Map<string, object>}}
 */
export function buildWalletIndex(wallets) {
  const byAddress = new Map()
  const byDomain = new Map()
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
    const domain = domainOf(sender)
    if (domain && !byDomain.has(domain)) byDomain.set(domain, w)
  }

  return { senders, byAddress, byDomain }
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
  return index.byAddress.get(address) || index.byDomain.get(domainOf(address)) || null
}

/**
 * Stable `source` value for a wallet. This is half of the dedup key, so it must
 * not change once transactions exist -- derive it from the wallet's UUID-backed
 * name only, never from anything sync-run specific.
 *
 * @param {object|null} wallet
 * @returns {string}
 */
export function walletSource(wallet) {
  if (!wallet?.name) return 'email'
  return String(wallet.name).trim().toLowerCase().replace(/\s+/g, '_')
}
