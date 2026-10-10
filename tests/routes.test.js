import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { NAV_ITEMS } from '../src/lib/nav.js'

// App.jsx is JSX, which Node cannot import here, so the routes are read as
// text. The point is small and worth a test: a nav entry whose path has no
// <Route> falls through to the catch-all and lands on Daily HQ silently.
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const routePaths = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1])

describe('routes', () => {
  it('registers a route for every navigation item', () => {
    for (const item of NAV_ITEMS) expect(routePaths).toContain(item.path)
  })

  it('keeps a catch-all so an unknown path lands somewhere', () => {
    expect(routePaths).toContain('*')
  })
})
