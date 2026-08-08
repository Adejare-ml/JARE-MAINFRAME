/**
 * Building and running Gmail search queries.
 *
 * Two things here matter for correctness:
 *
 * 1. `after:` is given a UNIX timestamp rather than YYYY/MM/DD. The date form is
 *    interpreted in the *account's* timezone (Lagos, UTC+1) while our clock is
 *    UTC, and it is only day-granular, so every run re-scanned the whole day.
 *    Epoch seconds are unambiguous and precise.
 * 2. Results are paginated to exhaustion. Capping at one page and then advancing
 *    last_sync loses every message past the cap, permanently.
 */

/** Re-scan this far before last_sync, so a message that lands moments after a
 *  sync starts isn't skipped. Safe because inserts are idempotent. */
const OVERLAP_SECONDS = 60 * 60

/** Refuse to walk more than this many pages in one run. */
export const MAX_PAGES = 10
export const PAGE_SIZE = 100

/**
 * Format a date as YYYY/MM/DD for Gmail. Kept for display and for callers that
 * want the human-readable form; the query builder uses epoch seconds instead.
 *
 * @param {string|number|Date} date
 * @returns {string}
 */
export function formatDateForGmail(date) {
  const d = new Date(date)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

/**
 * Build the Gmail search query for a set of sender addresses.
 *
 * @param {string[]} senders - alert sender addresses
 * @param {string|number|Date|null} since - last successful sync, or null for a
 *   first run (defaults to 30 days back)
 * @param {number} [nowMs] - injectable clock, for tests
 * @returns {string}
 */
export function buildSenderQuery(senders, since, nowMs = Date.now()) {
  const unique = [...new Set(senders.filter(Boolean).map((s) => s.trim().toLowerCase()))]
  if (unique.length === 0) return ''

  const sinceMs = since ? new Date(since).getTime() : nowMs - 30 * 24 * 60 * 60 * 1000
  const afterEpoch = Math.max(0, Math.floor(sinceMs / 1000) - OVERLAP_SECONDS)

  const fromClauses = unique.map((s) => `from:${s}`).join(' OR ')
  return `(${fromClauses}) after:${afterEpoch}`
}

/**
 * List every message matching a query, following nextPageToken to exhaustion.
 *
 * Returns `truncated: true` when MAX_PAGES was hit, so the caller can log it and
 * hold last_sync back rather than silently pretending it saw everything.
 *
 * @param {string} query
 * @param {object} headers - auth headers
 * @param {(url: string, init: object) => Promise<Response>} fetchFn
 * @returns {Promise<{messages: Array<{id: string}>, truncated: boolean}>}
 */
export async function listAllMessages(query, headers, fetchFn) {
  const messages = []
  let pageToken = null
  let pages = 0
  let truncated = false

  do {
    if (pages >= MAX_PAGES) {
      truncated = true
      break
    }

    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages')
    url.searchParams.set('q', query)
    url.searchParams.set('maxResults', String(PAGE_SIZE))
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetchFn(url.toString(), { headers })
    if (!res.ok) {
      const errText = await res.text()
      const err = new Error(`Gmail API messages query failed (${res.status}): ${errText}`)
      err.status = res.status
      throw err
    }

    const data = await res.json()
    if (data.messages) messages.push(...data.messages)
    pageToken = data.nextPageToken || null
    pages++
  } while (pageToken)

  return { messages, truncated }
}
