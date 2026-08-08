/**
 * Deterministic dedup keys for transactions that arrive without a bank reference.
 *
 * Some alerts carry no usable reference at all -- GTBank charge and stamp-duty
 * emails ship an empty Document Number -- so we synthesise a stable ID from the
 * transaction's own content instead.
 *
 * The hash MUST be deterministic and MUST produce the same value in the browser
 * and in Node, because the frontend sync and the background Action both write to
 * the same table and dedup against each other. FNV-1a over BigInt gives us that
 * with no crypto import and no async.
 */

const SYNTHETIC_PREFIX = 'SYN-'

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n
const FNV_PRIME_64 = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/**
 * FNV-1a, 64-bit. Identical output in Node 22 and every modern browser.
 * @param {string} input
 * @returns {string} 16 lowercase hex characters
 */
export function fnv1a64(input) {
  let hash = FNV_OFFSET_BASIS_64

  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff)
    hash = (hash * FNV_PRIME_64) & MASK_64
  }

  return hash.toString(16).padStart(16, '0')
}

/**
 * Build the natural key a transaction is identified by when it has no bank
 * reference. Normalised so that cosmetic differences between two renderings of
 * the same alert -- extra whitespace, casing, "20000" vs "20000.00" -- collapse
 * to one key.
 *
 * @param {string} source
 * @param {number|string} amount
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} description
 * @returns {string}
 */
export function buildNaturalKey(source, amount, dateStr, description) {
  const normSource = String(source || '').trim().toLowerCase()
  const normAmount = Number.isFinite(Number(amount)) ? Number(amount).toFixed(2) : '0.00'
  const normDate = String(dateStr || '').trim()
  const normDesc = String(description || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 60)

  return `${normSource}|${normAmount}|${normDate}|${normDesc}`
}

/**
 * Generate a synthetic transaction ID for dedup.
 *
 * Deliberately contains no timestamp and no randomness: calling this twice with
 * the same transaction must return the same string, or the same email is
 * inserted again on every sync.
 *
 * @param {string} source
 * @param {number|string} amount
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} description
 * @returns {string} e.g. "SYN-a3f19c04be27d155"
 */
export function generateSyntheticId(source, amount, dateStr, description) {
  return SYNTHETIC_PREFIX + fnv1a64(buildNaturalKey(source, amount, dateStr, description))
}

/**
 * True when an ID was synthesised by us rather than read off the email.
 * Synthetic IDs need the extra natural-key dedup guard; bank references don't.
 *
 * @param {string} transactionId
 * @returns {boolean}
 */
export function isSyntheticId(transactionId) {
  return typeof transactionId === 'string' && transactionId.startsWith(SYNTHETIC_PREFIX)
}

export { SYNTHETIC_PREFIX }
