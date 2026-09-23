/**
 * Web push, the pure parts.
 *
 * Everything the browser side needs that does not touch the DOM: turning
 * the VAPID public key into the bytes PushManager.subscribe wants, turning
 * a PushSubscription into the row push_subscriptions stores (migration
 * 031), and deciding whether this device can subscribe at all. The
 * component (Settings -> Reminders) does the asking; the service worker
 * (public/sw.js) does the showing.
 */

/**
 * A URL-safe base64 VAPID key as the Uint8Array applicationServerKey.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function urlBase64ToUint8Array(base64) {
  const trimmed = String(base64 || '').trim()
  if (!trimmed) return new Uint8Array(0)
  const padding = '='.repeat((4 - (trimmed.length % 4)) % 4)
  const standard = (trimmed + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = typeof atob === 'function' ? atob(standard) : Buffer.from(standard, 'base64').toString('binary')
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * The row to upsert for a PushSubscription, or null when it lacks a key.
 *
 * Reads the keys through toJSON(), which every browser implements and
 * which yields the URL-safe base64 web-push expects; getKey() would give
 * ArrayBuffers that need re-encoding.
 *
 * @param {PushSubscription|{endpoint: string, keys?: {p256dh?: string, auth?: string}, toJSON?: Function}} subscription
 * @param {string} [userAgent]
 * @returns {{endpoint: string, p256dh: string, auth: string, user_agent: string|null} | null}
 */
export function subscriptionToRow(subscription, userAgent = null) {
  if (!subscription) return null
  const json = typeof subscription.toJSON === 'function' ? subscription.toJSON() : subscription
  const endpoint = typeof json?.endpoint === 'string' ? json.endpoint.trim() : ''
  const p256dh = json?.keys?.p256dh
  const auth = json?.keys?.auth
  if (!endpoint || !p256dh || !auth) return null
  return {
    endpoint,
    p256dh,
    auth,
    user_agent: typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim().slice(0, 200) : null,
  }
}

/**
 * Can this device subscribe, and if not, why.
 *
 * iOS only exposes PushManager to an installed (home-screen) app, so the
 * most useful "no" names the fix rather than the missing API.
 *
 * @param {{navigator?: object, window?: object}} env
 * @returns {{supported: boolean, reason: null|'no-service-worker'|'no-push'|'ios-not-installed'|'insecure'}}
 */
export function pushSupport({ navigator: nav, window: win } = {}) {
  if (!nav || !win) return { supported: false, reason: 'no-service-worker' }
  if (win.isSecureContext === false) return { supported: false, reason: 'insecure' }
  if (!('serviceWorker' in nav)) return { supported: false, reason: 'no-service-worker' }
  if (!('PushManager' in win) || !('Notification' in win)) {
    const ua = String(nav.userAgent || '')
    const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (nav.maxTouchPoints || 0) > 1)
    const standalone = win.matchMedia?.('(display-mode: standalone)')?.matches || nav.standalone === true
    if (ios && !standalone) return { supported: false, reason: 'ios-not-installed' }
    return { supported: false, reason: 'no-push' }
  }
  return { supported: true, reason: null }
}

/** What to say for each reason pushSupport can give. */
export const SUPPORT_MESSAGES = {
  'ios-not-installed': 'On iPhone, add the app to your Home Screen first (Share → Add to Home Screen), then open it from there.',
  'no-push': 'This browser cannot receive push notifications.',
  'no-service-worker': 'This browser cannot run the background worker that shows notifications.',
  insecure: 'Notifications need a secure (https) address.',
}
