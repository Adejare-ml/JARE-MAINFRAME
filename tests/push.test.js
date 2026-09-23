import { describe, it, expect } from 'vitest'
import { urlBase64ToUint8Array, subscriptionToRow, pushSupport, SUPPORT_MESSAGES } from '../src/lib/push.js'

describe('urlBase64ToUint8Array', () => {
  it('decodes a URL-safe key, restoring padding', () => {
    // "hello" in standard base64 is aGVsbG8=; URL-safe drops the padding.
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111])
  })

  it('maps - and _ back to + and /', () => {
    // 0xfb 0xff in standard base64 is "+/8=", URL-safe "-_8".
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255])
  })

  it('is empty for a blank key rather than throwing', () => {
    expect(urlBase64ToUint8Array('')).toHaveLength(0)
    expect(urlBase64ToUint8Array(undefined)).toHaveLength(0)
  })
})

describe('subscriptionToRow', () => {
  const sub = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: 'BPk', auth: 'aut' },
    toJSON() {
      return { endpoint: this.endpoint, expirationTime: null, keys: this.keys }
    },
  }

  it('reads endpoint and keys through toJSON', () => {
    expect(subscriptionToRow(sub, 'Mozilla/5.0 (Android)')).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: 'BPk',
      auth: 'aut',
      user_agent: 'Mozilla/5.0 (Android)',
    })
  })

  it('accepts a plain object too, and drops a blank user agent', () => {
    const row = subscriptionToRow({ endpoint: ' https://push.example/x ', keys: { p256dh: 'p', auth: 'a' } }, '  ')
    expect(row.endpoint).toBe('https://push.example/x')
    expect(row.user_agent).toBeNull()
  })

  it('caps the user agent', () => {
    expect(subscriptionToRow(sub, 'x'.repeat(500)).user_agent).toHaveLength(200)
  })

  it('is null without an endpoint or either key', () => {
    expect(subscriptionToRow(null)).toBeNull()
    expect(subscriptionToRow({ endpoint: '', keys: { p256dh: 'p', auth: 'a' } })).toBeNull()
    expect(subscriptionToRow({ endpoint: 'https://x', keys: { p256dh: 'p' } })).toBeNull()
  })
})

describe('pushSupport', () => {
  const chrome = {
    navigator: { serviceWorker: {}, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/128' },
    window: { PushManager: function () {}, Notification: function () {}, isSecureContext: true },
  }

  it('says yes on a browser with a worker, PushManager and Notification', () => {
    expect(pushSupport(chrome)).toEqual({ supported: true, reason: null })
  })

  it('names the Home Screen fix on an iPhone in Safari', () => {
    const result = pushSupport({
      navigator: { serviceWorker: {}, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1', standalone: false },
      window: { isSecureContext: true, matchMedia: () => ({ matches: false }) },
    })
    expect(result).toEqual({ supported: false, reason: 'ios-not-installed' })
    expect(SUPPORT_MESSAGES[result.reason]).toMatch(/Home Screen/)
  })

  it('treats an iPad that calls itself a Mac the same way', () => {
    const result = pushSupport({
      navigator: { serviceWorker: {}, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1', maxTouchPoints: 5 },
      window: { isSecureContext: true, matchMedia: () => ({ matches: false }) },
    })
    expect(result.reason).toBe('ios-not-installed')
  })

  it('says plain no-push on a desktop browser without the API', () => {
    const result = pushSupport({
      navigator: { serviceWorker: {}, userAgent: 'Mozilla/5.0 (X11; Linux) Firefox/50' },
      window: { isSecureContext: true },
    })
    expect(result.reason).toBe('no-push')
  })

  it('refuses an insecure context and a missing worker, and survives no environment', () => {
    expect(pushSupport({ navigator: { serviceWorker: {} }, window: { isSecureContext: false } }).reason).toBe('insecure')
    expect(pushSupport({ navigator: {}, window: { isSecureContext: true } }).reason).toBe('no-service-worker')
    expect(pushSupport().supported).toBe(false)
  })

  it('has a message for every reason', () => {
    for (const reason of ['ios-not-installed', 'no-push', 'no-service-worker', 'insecure']) {
      expect(SUPPORT_MESSAGES[reason]).toBeTruthy()
    }
  })
})
