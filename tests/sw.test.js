import { describe, it, expect, beforeAll } from 'vitest'

/**
 * public/sw.js is a classic worker script: no imports, no exports, and it
 * talks to `self`. Loading it under Node needs a stand-in for that global
 * that swallows the three addEventListener calls; the routing decision is
 * then read off self.__jareRouting, which the worker exposes for exactly
 * this purpose.
 */
const ORIGIN = 'https://jare-mainframe.pages.dev'
let routing

beforeAll(async () => {
  const listeners = {}
  globalThis.self = {
    location: { origin: ORIGIN },
    addEventListener(name, fn) {
      listeners[name] = fn
    },
    __listeners: listeners,
  }
  await import('../public/sw.js')
  routing = globalThis.self.__jareRouting
})

const url = (path, origin = ORIGIN) => new URL(path, origin)

describe('the worker registers its handlers', () => {
  it('lifecycle, fetch, and the two for notifications -- nothing else', () => {
    expect(Object.keys(globalThis.self.__listeners).sort()).toEqual([
      'activate',
      'fetch',
      'install',
      'notificationclick',
      'push',
    ])
  })
})

describe('notificationFor', () => {
  it('turns the digest payload into a notification with a same-origin tap target', () => {
    const shown = routing.notificationFor(
      JSON.stringify({ title: '2 things need you today', body: 'Rent due · 4 to review', url: '/debts' }),
      ORIGIN,
    )
    expect(shown.title).toBe('2 things need you today')
    expect(shown.options.body).toBe('Rent due · 4 to review')
    expect(shown.options.data.url).toBe(`${ORIGIN}/debts`)
    expect(shown.options.tag).toBe('jare-reminder')
    expect(shown.options.icon).toBe('/icons/icon-192.png')
  })

  it('shows nothing for a malformed or empty push', () => {
    expect(routing.notificationFor(null, ORIGIN)).toBeNull()
    expect(routing.notificationFor('not json', ORIGIN)).toBeNull()
    expect(routing.notificationFor(JSON.stringify({ body: 'no title' }), ORIGIN)).toBeNull()
    expect(routing.notificationFor(JSON.stringify({ title: '   ' }), ORIGIN)).toBeNull()
  })

  it('never sends a tap off this origin', () => {
    expect(routing.clickTarget('https://evil.example/phish', ORIGIN)).toBe(`${ORIGIN}/`)
    expect(routing.clickTarget('//evil.example/phish', ORIGIN)).toBe(`${ORIGIN}/`)
    expect(routing.clickTarget('/transactions?from=2026-07-01', ORIGIN)).toBe(`${ORIGIN}/transactions?from=2026-07-01`)
    expect(routing.clickTarget(undefined, ORIGIN)).toBe(`${ORIGIN}/`)
    expect(routing.clickTarget(42, ORIGIN)).toBe(`${ORIGIN}/`)
  })
})

describe('strategyFor', () => {
  it('serves navigations from the network, shell as fallback', () => {
    expect(routing.strategyFor(url('/'), 'navigate', ORIGIN)).toBe('shell')
    expect(routing.strategyFor(url('/budget?month=2026-07'), 'navigate', ORIGIN)).toBe('shell')
  })

  it('caches hashed build assets first', () => {
    expect(routing.strategyFor(url('/assets/index-DeyEr8Fh.js'), 'cors', ORIGIN)).toBe('asset')
    expect(routing.strategyFor(url('/assets/index-abc123.css'), 'no-cors', ORIGIN)).toBe('asset')
  })

  // The one rule that must never be wrong: a cached auth response or a
  // cached ledger is a stale balance shown as current.
  it('never touches another origin', () => {
    expect(routing.strategyFor(url('/rest/v1/transactions', 'https://sgqafsfwyfazpaagljwq.supabase.co'), 'cors', ORIGIN)).toBe('network')
    expect(routing.strategyFor(url('/auth/v1/token', 'https://sgqafsfwyfazpaagljwq.supabase.co'), 'cors', ORIGIN)).toBe('network')
    expect(routing.strategyFor(url('/gmail/v1/users/me/messages', 'https://gmail.googleapis.com'), 'cors', ORIGIN)).toBe('network')
    // Even a path that looks like an asset, on the wrong origin.
    expect(routing.strategyFor(url('/assets/x.js', 'https://evil.example'), 'cors', ORIGIN)).toBe('network')
  })

  it('leaves the unhashed files to the network so they can change', () => {
    expect(routing.strategyFor(url('/sw.js'), 'same-origin', ORIGIN)).toBe('network')
    expect(routing.strategyFor(url('/manifest.webmanifest'), 'same-origin', ORIGIN)).toBe('network')
    expect(routing.strategyFor(url('/favicon.svg'), 'no-cors', ORIGIN)).toBe('network')
  })

  it('survives a missing url', () => {
    expect(routing.strategyFor(null, 'navigate', ORIGIN)).toBe('network')
  })
})

describe('what gets stored', () => {
  it('only an HTML response counts as the shell', () => {
    expect(routing.isHtml('text/html; charset=utf-8')).toBe(true)
    expect(routing.isHtml('application/manifest+json')).toBe(false)
    expect(routing.isHtml(null)).toBe(false)
  })

  it('keeps only this version\'s caches on activate', () => {
    expect(routing.keepsCache(`${routing.VERSION}-shell`)).toBe(true)
    expect(routing.keepsCache(`${routing.VERSION}-assets`)).toBe(true)
    expect(routing.keepsCache('jare-v0-shell')).toBe(false)
    expect(routing.keepsCache('workbox-precache')).toBe(false)
  })

  it('caps the asset cache at a sane number of chunks', () => {
    expect(routing.ASSET_LIMIT).toBeGreaterThanOrEqual(20)
    expect(routing.ASSET_LIMIT).toBeLessThanOrEqual(200)
    expect(routing.SHELL_URL).toBe('/')
  })
})
