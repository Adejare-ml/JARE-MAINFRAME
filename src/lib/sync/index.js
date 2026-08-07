/**
 * Shared Gmail sync core.
 *
 * Imported by both the frontend manual sync (src/lib/gmailSync.js) and the
 * background GitHub Action (scripts/gmail-sync.mjs). These two used to be
 * near-identical copies that drifted apart -- different dedup hashes, different
 * page caps -- and every bug that produced lived in the gap between them. There
 * is one implementation now.
 */

export {
  fnv1a64,
  buildNaturalKey,
  generateSyntheticId,
  isSyntheticId,
  SYNTHETIC_PREFIX,
} from './dedup.js'

export {
  stripHtml,
  toStandardBase64,
  extractEmailBody,
  getSenderEmail,
  getMessageDate,
  getDomain,
} from './email.js'

export {
  formatDateForGmail,
  buildSenderQuery,
  listAllMessages,
  MAX_PAGES,
  PAGE_SIZE,
} from './gmailQuery.js'

export {
  validateParsedTransaction,
  extractJsonObject,
  isValidDate,
  VALID_TYPES,
  VALID_CONFIDENCE,
  RAW_EMAIL_MAX_CHARS,
} from './normalize.js'

export {
  getParseStrategy,
  buildWalletIndex,
  matchWallet,
  walletSource,
  PARSE_STRATEGIES,
  DEFAULT_PARSE_STRATEGY,
} from './wallets.js'
