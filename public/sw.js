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
 * Bump VERSION to purge every cache on the next activate. The push and
 * notificationclick handlers arrive with the reminders work (Stage 20).
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

self.__jareRouting = { VERSION, SHELL_URL, ASSET_LIMIT, strategyFor, isHtml, keepsCache }

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
