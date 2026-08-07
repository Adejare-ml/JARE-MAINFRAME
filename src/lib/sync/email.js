/**
 * Gmail message payload handling, shared by the frontend sync and the
 * background Action. Everything here is pure -- the only platform difference,
 * base64 decoding, is passed in by the caller.
 */

/**
 * Strip HTML down to the plain text the parsers expect. Bank alerts arrive as
 * table-heavy HTML, so row and cell boundaries have to survive as whitespace or
 * the "Label : Value" patterns the parsers match on get glued together.
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html || typeof html !== 'string') return ''
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n\s*\n/g, '\n')
    .trim()
}

/**
 * Convert Gmail's URL-safe base64 to standard base64.
 * @param {string} data
 * @returns {string}
 */
export function toStandardBase64(data) {
  return data.replace(/-/g, '+').replace(/_/g, '/')
}

/**
 * Walk a Gmail message payload and pull out the best available body text.
 * Prefers text/plain, falls back to text/html, then recurses into multipart
 * containers, then finally the snippet.
 *
 * @param {object} payload - Gmail API message payload
 * @param {(data: string) => string} decodeBase64 - platform base64 decoder
 * @returns {string} plain text
 */
export function extractEmailBody(payload, decodeBase64) {
  if (!payload) return ''

  let rawBody = ''

  if (payload.body && payload.body.data) {
    try {
      rawBody = decodeBase64(toStandardBase64(payload.body.data))
    } catch {
      // Malformed part -- fall through to the other candidates below.
    }
  }

  if (!rawBody && payload.parts && payload.parts.length > 0) {
    // text/plain across all parts first, so a multipart/alternative message
    // doesn't hand us the HTML twin when a clean text version is sitting there.
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        try {
          rawBody = decodeBase64(toStandardBase64(part.body.data))
          if (rawBody) break
        } catch {
          // Try the next part.
        }
      }
    }

    if (!rawBody) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          try {
            rawBody = decodeBase64(toStandardBase64(part.body.data))
            if (rawBody) break
          } catch {
            // Try the next part.
          }
        }
      }
    }

    if (!rawBody) {
      for (const part of payload.parts) {
        if (part.parts) {
          const sub = extractEmailBody(part, decodeBase64)
          if (sub) {
            // Already stripped by the recursive call.
            return sub
          }
        }
      }
    }
  }

  if (!rawBody) {
    rawBody = payload.snippet || ''
  }

  return stripHtml(rawBody)
}

/**
 * Read the sender address out of the From header.
 * Handles both "Name <a@b.com>" and a bare "a@b.com".
 *
 * @param {object} payload - Gmail API message payload
 * @returns {string} lowercased address, or ''
 */
export function getSenderEmail(payload) {
  if (!payload || !payload.headers) return ''
  const fromHeader = payload.headers.find((h) => h.name.toLowerCase() === 'from')
  if (!fromHeader) return ''
  const match = fromHeader.value.match(/<([^>]+)>/)
  return match ? match[1].toLowerCase() : fromHeader.value.trim().toLowerCase()
}

/**
 * Read the message's internal date as an ISO string.
 * Used to set last_sync from the oldest processed message rather than "now".
 *
 * @param {object} msgData - full Gmail API message
 * @returns {string|null} ISO timestamp
 */
export function getMessageDate(msgData) {
  if (!msgData?.internalDate) return null
  const ms = Number(msgData.internalDate)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/**
 * @param {string} email
 * @returns {string} domain part, lowercased
 */
export function getDomain(email) {
  const at = String(email || '').lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : ''
}
