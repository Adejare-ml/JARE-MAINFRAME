/**
 * The navigation, in one place.
 *
 * Sidebar and BottomNav each carried their own copy of this array, so they
 * could disagree — and did: `/transactions`, the module the whole email-parsing
 * pipeline exists to feed, appeared in neither, while four static placeholder
 * pages held prime space on a phone.
 *
 * Projects and Repairs are hidden rather than deleted: their routes still
 * resolve, so a bookmarked URL works, but they do not spend a nav slot until
 * they do something. Restore them by flipping `hidden`.
 */
export const NAV_ITEMS = [
  { path: '/', label: 'Daily HQ', icon: '🏠' },
  { path: '/budget', label: 'Budget', icon: '💰' },
  { path: '/transactions', label: 'Ledger', icon: '🧾' },
  { path: '/goals', label: 'Goals', icon: '🎯' },
  { path: '/debts', label: 'Debts', icon: '🤝' },
  // Settings has its own gear in the mobile header (see Layout.jsx), so it is
  // desktop-only here rather than a sixth thumb target.
  { path: '/settings', label: 'Settings', icon: '⚙️', desktopOnly: true },

  { path: '/projects', label: 'Projects', icon: '🛠️', hidden: true },
  { path: '/repairs', label: 'Repairs', icon: '🔧', hidden: true },
]

/** Items for the desktop sidebar. */
export const sidebarItems = () => NAV_ITEMS.filter((i) => !i.hidden)

/** Items for the mobile bottom bar. */
export const bottomNavItems = () => NAV_ITEMS.filter((i) => !i.hidden && !i.desktopOnly)
