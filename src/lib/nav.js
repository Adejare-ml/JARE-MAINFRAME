/**
 * The navigation, in one place.
 *
 * Sidebar and BottomNav each carried their own copy of this array, so they
 * could disagree — and did: `/transactions`, the module the whole email-parsing
 * pipeline exists to feed, appeared in neither, while four static placeholder
 * pages held prime space on a phone.
 *
 * The bottom bar holds five thumb targets and no more. Modules past the
 * five core ones are `secondary`: on the sidebar like everything else, and
 * on a phone reached the way Settings already is -- through the header gear
 * and a "Modules" row at the top of Settings -- plus a link from the page
 * they relate to. A route still hidden (`hidden`) resolves for a bookmark
 * but appears nowhere until its page does something.
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

  { path: '/projects', label: 'Projects', icon: '🛠️', desktopOnly: true, secondary: true },
  { path: '/repairs', label: 'Repairs', icon: '🔧', desktopOnly: true, secondary: true },
  { path: '/ask', label: 'Ask', icon: '💬', hidden: true },
]

/** Items for the desktop sidebar. */
export const sidebarItems = () => NAV_ITEMS.filter((i) => !i.hidden)

/** Items for the mobile bottom bar. */
export const bottomNavItems = () => NAV_ITEMS.filter((i) => !i.hidden && !i.desktopOnly)

/** Modules reachable from Settings on a phone, where the bottom bar is full. */
export const secondaryItems = () => NAV_ITEMS.filter((i) => !i.hidden && i.secondary)
