import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, sidebarItems, bottomNavItems, secondaryItems } from '../src/lib/nav.js'

describe('navigation', () => {
  // The whole point of the email parsing pipeline is the ledger, and it was
  // reachable only through "See all" links buried on two other pages.
  it('includes the transactions page', () => {
    expect(sidebarItems().map((i) => i.path)).toContain('/transactions')
    expect(bottomNavItems().map((i) => i.path)).toContain('/transactions')
  })

  // The hidden route resolves for a bookmark but earns no slot anywhere yet.
  it('keeps the still-hidden route off both surfaces', () => {
    expect(sidebarItems().map((i) => i.path)).not.toContain('/ask')
    expect(bottomNavItems().map((i) => i.path)).not.toContain('/ask')
  })

  // Projects and Repairs are real now, but the bottom bar is full: they take
  // the same route Settings does on a phone (header gear -> Modules) and a
  // sidebar slot on desktop.
  it('puts the secondary modules on the sidebar and in the Modules list, never the bottom bar', () => {
    for (const path of ['/projects', '/repairs']) {
      expect(sidebarItems().map((i) => i.path)).toContain(path)
      expect(secondaryItems().map((i) => i.path)).toContain(path)
      expect(bottomNavItems().map((i) => i.path)).not.toContain(path)
    }
  })

  it('never lists a hidden route as a secondary module', () => {
    expect(secondaryItems().every((i) => !i.hidden)).toBe(true)
  })

  it('keeps hidden items in the source list so their routes stay documented', () => {
    expect(NAV_ITEMS.map((i) => i.path)).toContain('/ask')
  })

  // Layout renders a settings gear in the mobile header; a second entry in the
  // bottom bar would be a duplicate and a fifth crowded target.
  it('keeps Settings on desktop only', () => {
    expect(sidebarItems().map((i) => i.path)).toContain('/settings')
    expect(bottomNavItems().map((i) => i.path)).not.toContain('/settings')
  })

  it('fits five items on the bottom bar', () => {
    expect(bottomNavItems().length).toBeLessThanOrEqual(5)
  })

  it('has no duplicate paths and every item is renderable', () => {
    const paths = NAV_ITEMS.map((i) => i.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const item of NAV_ITEMS) {
      expect(item.label).toBeTruthy()
      expect(item.icon).toBeTruthy()
      expect(item.path.startsWith('/')).toBe(true)
    }
  })
})
