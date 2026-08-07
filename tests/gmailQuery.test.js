import { describe, it, expect, vi } from 'vitest'
import { buildSenderQuery, listAllMessages, MAX_PAGES } from '../src/lib/sync/gmailQuery.js'
import { getMessageDate, extractEmailBody, stripHtml, getSenderEmail } from '../src/lib/sync/email.js'

const NOW = new Date('2026-08-07T12:00:00Z').getTime()
const decode = (data) => Buffer.from(data, 'base64').toString('utf-8')
const b64url = (text) =>
  Buffer.from(text, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')

describe('buildSenderQuery', () => {
  it('ORs the senders together', () => {
    const q = buildSenderQuery(['a@x.com', 'b@y.com'], null, NOW)
    expect(q).toContain('(from:a@x.com OR from:b@y.com)')
  })

  // Date-form `after:` is interpreted in the account's timezone (Lagos) while
  // our clock is UTC, and it is only day-granular. Epoch seconds are neither.
  it('uses an epoch timestamp rather than a date string', () => {
    const q = buildSenderQuery(['a@x.com'], '2026-08-01T00:00:00Z', NOW)
    expect(q).toMatch(/after:\d+$/)
    expect(q).not.toMatch(/after:\d{4}\//)
  })

  it('overlaps slightly behind last_sync so nothing lands in the gap', () => {
    const since = '2026-08-01T00:00:00Z'
    const after = Number(buildSenderQuery(['a@x.com'], since, NOW).match(/after:(\d+)/)[1])
    const sinceEpoch = Math.floor(new Date(since).getTime() / 1000)

    expect(after).toBeLessThan(sinceEpoch)
    expect(sinceEpoch - after).toBe(3600)
  })

  it('looks back 30 days on a first run', () => {
    const after = Number(buildSenderQuery(['a@x.com'], null, NOW).match(/after:(\d+)/)[1])
    const expected = Math.floor(NOW / 1000) - 30 * 24 * 3600 - 3600

    expect(after).toBe(expected)
  })

  it('deduplicates and lowercases senders', () => {
    const q = buildSenderQuery(['A@X.com', 'a@x.com', ' a@x.com '], null, NOW)
    expect(q.match(/from:/g)).toHaveLength(1)
  })

  it('returns an empty query when there are no senders', () => {
    expect(buildSenderQuery([], null, NOW)).toBe('')
    expect(buildSenderQuery([null, ''], null, NOW)).toBe('')
  })
})

describe('listAllMessages', () => {
  const page = (ids, nextPageToken) => ({
    ok: true,
    json: async () => ({ messages: ids.map((id) => ({ id })), ...(nextPageToken ? { nextPageToken } : {}) }),
  })

  // The bug this replaces: a single capped page, followed by advancing
  // last_sync, lost every message past the cap permanently.
  it('follows nextPageToken to exhaustion', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(page(['a', 'b'], 'tok1'))
      .mockResolvedValueOnce(page(['c', 'd'], 'tok2'))
      .mockResolvedValueOnce(page(['e']))

    const { messages, truncated } = await listAllMessages('q', {}, fetchFn)

    expect(messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(truncated).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('passes the page token on subsequent requests only', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(page(['a'], 'tok1')).mockResolvedValueOnce(page(['b']))

    await listAllMessages('my query', {}, fetchFn)

    expect(fetchFn.mock.calls[0][0]).not.toContain('pageToken')
    expect(fetchFn.mock.calls[1][0]).toContain('pageToken=tok1')
    expect(fetchFn.mock.calls[0][0]).toContain('q=my+query')
  })

  it('reports truncation instead of silently stopping', async () => {
    const fetchFn = vi.fn().mockResolvedValue(page(['x'], 'always-more'))

    const { messages, truncated } = await listAllMessages('q', {}, fetchFn)

    expect(truncated).toBe(true)
    expect(messages).toHaveLength(MAX_PAGES)
    expect(fetchFn).toHaveBeenCalledTimes(MAX_PAGES)
  })

  it('handles an empty result set', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })

    const { messages, truncated } = await listAllMessages('q', {}, fetchFn)

    expect(messages).toEqual([])
    expect(truncated).toBe(false)
  })

  it('throws with the status attached so callers can detect an expired token', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'expired' })

    await expect(listAllMessages('q', {}, fetchFn)).rejects.toMatchObject({ status: 401 })
  })
})

describe('getMessageDate', () => {
  it('converts internalDate to ISO', () => {
    expect(getMessageDate({ internalDate: '1754568000000' })).toBe(new Date(1754568000000).toISOString())
  })

  it('returns null when there is no usable date', () => {
    expect(getMessageDate({})).toBeNull()
    expect(getMessageDate({ internalDate: 'nonsense' })).toBeNull()
    expect(getMessageDate(null)).toBeNull()
  })
})

describe('extractEmailBody', () => {
  it('prefers text/plain even when the HTML part comes first', () => {
    const payload = {
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>html twin</p>') } },
        { mimeType: 'text/plain', body: { data: b64url('plain original') } },
      ],
    }
    expect(extractEmailBody(payload, decode)).toBe('plain original')
  })

  it('falls back to text/html when there is no plain part', () => {
    const payload = { parts: [{ mimeType: 'text/html', body: { data: b64url('<p>Amount : NGN 5</p>') } }] }
    expect(extractEmailBody(payload, decode)).toBe('Amount : NGN 5')
  })

  it('recurses into nested multipart containers', () => {
    const payload = {
      parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64url('nested') } }] }],
    }
    expect(extractEmailBody(payload, decode)).toBe('nested')
  })

  it('falls back to the snippet when no part decodes', () => {
    expect(extractEmailBody({ snippet: 'just a snippet' }, decode)).toBe('just a snippet')
  })

  it('returns empty string for a missing payload', () => {
    expect(extractEmailBody(null, decode)).toBe('')
  })
})

describe('stripHtml', () => {
  it('keeps table cells apart so label/value pairs survive', () => {
    expect(stripHtml('<tr><td>Amount</td><td>NGN 20,000</td></tr>')).toContain('Amount')
    expect(stripHtml('<tr><td>Amount</td><td>NGN 20,000</td></tr>')).toContain('NGN 20,000')
    expect(stripHtml('<td>A</td><td>B</td>')).not.toContain('AB')
  })

  it('drops style and script content entirely', () => {
    expect(stripHtml('<style>.x{color:red}</style><p>Body</p>')).toBe('Body')
    expect(stripHtml('<script>var a = 1;</script><p>Body</p>')).toBe('Body')
  })

  it('decodes the common entities', () => {
    expect(stripHtml('A&nbsp;&amp;&nbsp;B')).toBe('A & B')
    expect(stripHtml('&lt;tag&gt; &quot;q&quot; &#39;s&#39;')).toBe('<tag> "q" \'s\'')
  })
})

describe('getSenderEmail', () => {
  it('reads the address out of a display-name header', () => {
    const payload = { headers: [{ name: 'From', value: 'GTBank Alerts <GeNS@gtbank.com>' }] }
    expect(getSenderEmail(payload)).toBe('gens@gtbank.com')
  })

  it('handles a bare address and a lowercase header name', () => {
    expect(getSenderEmail({ headers: [{ name: 'from', value: 'No-Reply@Opay-Nigeria.com' }] })).toBe(
      'no-reply@opay-nigeria.com',
    )
  })

  it('returns empty string when there is no From header', () => {
    expect(getSenderEmail({ headers: [] })).toBe('')
    expect(getSenderEmail(null)).toBe('')
  })
})
