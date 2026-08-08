import { describe, it, expect } from 'vitest'
import { NAV_ITEMS, sidebarItems, bottomNavItems } from '../src/lib/nav.js'

describe('navigation', () => {
  // The whole point of the email parsing pipeline is the ledger, and it was
  // reachable only through "See all" links buried on two other pages.
  it('includes the transactions page', () => {
    expect(sidebarItems().map((i) => i.path)).toContain('/transactions')
    expect(bottomNavItems().map((i) => i.path)).toContain('/transactions')
  })

  // Static placeholders with hardcoded zeros do not earn a thumb target.
  it('hides the placeholder modules from both surfaces', () => {
    for (const path of ['/projects', '/repairs']) {
      expect(sidebarItems().map((i) => i.path)).not.toContain(path)
      expect(bottomNavItems().map((i) => i.path)).not.toContain(path)
    }
  })

  it('keeps hidden items in the source list so their routes stay documented', () => {
    expect(NAV_ITEMS.map((i) => i.path)).toContain('/projects')
    expect(NAV_ITEMS.map((i) => i.path)).toContain('/repairs')
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
