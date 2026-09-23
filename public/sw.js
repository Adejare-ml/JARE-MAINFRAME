/*
 * Jare Mainframe service worker.
 *
 * Hand-rolled rather than generated: what it has to do fits on one screen,
 * and a precache manifest from a plugin is no more verifiable here than
 * this file is. Three rules, in strategyFor below:
 *
 *   1. Navigations are network-first, falling back to the cached shell
 *      (index.html) when the network is gone. The app then loads and every
 *      page shows its own error state with a Retry -- not a browser
 *      dinosaur. No offline writes: a log tapped offline still fails, and
 *      says so.
 *   2. Built assets under /assets/ are cache-first. Vite hashes their
 *      names, so a cached copy is never stale, only unused once a new build
 *      references new names. A small cap keeps old builds from piling up.
 *   3. Everything else -- Supabase, Google, the manifest, the favicon --
 *      goes straight to the network. Auth and data are never cached here,
 *      and the unhashed files are tiny.
 *
 * Bump VERSION to purge every cache on the next activate.
 *
 * The push and notificationclick handlers show the morning reminder
 * (scripts/remind.mjs sends it; Settings -> Reminders subscribes). The
 * payload is the digest's own shape: {title, body, url}.
 *
 * The routing decision is exposed on self.__jareRouting so tests/sw.test.js
 * can load this file under Node with a shimmed `self` and exercise it
 * without a browser.
 */

const VERSION = 'jare-v1'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`
const SHELL_URL = '/'
// Roughly three builds' worth of chunks. Oldest entries go first.
const ASSET_LIMIT = 60

/**
 * Which rule a request falls under.
 *
 * @param {URL} url
 * @param {string} mode - the Request's mode ('navigate' for a page load)
 * @param {string} origin - this worker's origin
 * @returns {'shell'|'asset'|'network'}
 */
function strategyFor(url, mode, origin) {
  if (!url || url.origin !== origin) return 'network'
  if (mode === 'navigate') return 'shell'
  if (url.pathname.startsWith('/assets/')) return 'asset'
  return 'network'
}

/** True when a navigation response is the HTML shell and worth keeping. */
function isHtml(contentType) {
  return /text\/html/i.test(contentType || '')
}

/** True for a cache this version owns; everything else is purged on activate. */
function keepsCache(name) {
  return name === SHELL_CACHE || name === ASSET_CACHE
}

/**
 * The notification to show for a push payload, or null for one this worker
 * does not understand -- a malformed push shows nothing rather than an
 * empty box. `url` is kept same-origin: a payload cannot send a tap
 * anywhere but this app.
 *
 * @param {string|null} raw - event.data?.text()
 * @param {string} origin
 * @returns {{title: string, options: object} | null}
 */
function notificationFor(raw, origin) {
  if (!raw) return null
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  const title = typeof payload?.title === 'string' ? payload.title.trim() : ''
  if (!title) return null
  const body = typeof payload.body === 'string' ? payload.body : ''
  return {
    title,
    options: {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // One tag: a second reminder replaces the first instead of stacking.
      tag: 'jare-reminder',
      data: { url: clickTarget(payload.url, origin) },
    },
  }
}

/** An absolute same-origin URL for a tap, falling back to the app root. */
function clickTarget(url, origin) {
  try {
    const target = new URL(typeof url === 'string' ? url : '/', origin)
    return target.origin === origin ? target.href : `${origin}/`
  } catch {
    return `${origin}/`
  }
}

self.__jareRouting = {
  VERSION,
  SHELL_URL,
  ASSET_LIMIT,
  strategyFor,
  isHtml,
  keepsCache,
  notificationFor,
  clickTarget,
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // cache: 'reload' skips the HTTP cache so the shell stored here is
      // the one the server has now, not one a CDN edge remembered.
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => !keepsCache(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  const strategy = strategyFor(url, request.mode, self.location.origin)

  if (strategy === 'shell') event.respondWith(shellNetworkFirst(request))
  else if (strategy === 'asset') event.respondWith(assetCacheFirst(request))
  // 'network': not handled, so the browser does exactly what it did before.
})

async function shellNetworkFirst(request) {
  try {
    const response = await fetch(request)
    // Only the HTML shell is stored, and only a good copy of it. A
    // navigation can also land on a real file (the manifest opened in a
    // tab), and a 5xx page is not a shell anyone wants back offline.
    if (response.ok && isHtml(response.headers.get('content-type'))) {
      const cache = await caches.open(SHELL_CACHE)
      cache.put(SHELL_URL, response.clone())
    }
    return response
  } catch (err) {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE })
    if (cached) return cached
    throw err
  }
}

async function assetCacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
    trimCache(cache, ASSET_LIMIT)
  }
  return response
}

/** Drop the oldest entries past the cap. keys() returns insertion order. */
async function trimCache(cache, limit) {
  const keys = await cache.keys()
  if (keys.length <= limit) return
  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)))
}

self.addEventListener('push', (event) => {
  const shown = notificationFor(event.data ? event.data.text() : null, self.location.origin)
  if (!shown) return
  event.waitUntil(self.registration.showNotification(shown.title, shown.options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || `${self.location.origin}/`
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Reuse an open tab of the app rather than opening a second one.
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (existing) {
        return existing.focus().then((w) => (w && 'navigate' in w ? w.navigate(url) : w))
      }
      return self.clients.openWindow(url)
    }),
  )
})
