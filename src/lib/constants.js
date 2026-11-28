export const CATEGORIES = {
  'Essentials': [
    'Feeding / Groceries',
    'Transport',
    'Airtime & Data',
    'Electricity',
    'Generator',
    'Rent',
    'Water',
  ],
  'Work & Growth': [
    'Work Expenses',
    'Courses & Learning',
    'Tools & Software',
    'Equipment',
  ],
  'Health': [
    'Pharmacy',
    'Hospital / Clinic',
    'Personal Care',
  ],
  'Social & Family': [
    'Family Support',
    'Social Events',
    'Church / Mosque',
    'Ajo / Esusu',
  ],
  // Everything in this group except Loan Repayment and Bank Charges is money
  // moving between your own pockets rather than being earned or spent. Anything
  // added here that is a transfer must also go in TRANSFER_CATEGORIES
  // (src/lib/summary.js) or it starts counting as income or spending.
  'Financial': [
    'Loan Repayment',
    'Bank Charges',
    'Savings Transfer',
    'Savings',
    'Investment',
    'Cash Withdrawal',
    'Cash Received',
    'Transfer Out',
    'Transfer In',
  ],
  'Personal': [
    'Clothing & Fashion',
    'Entertainment',
    'Dining Out',
    'Subscriptions',
  ],
  'Other': [
    'Repairs',
    'Miscellaneous',
    'Uncategorized',
  ],
}

/**
 * Category name to glyph name (src/components/ui/Icon.jsx). The names are
 * the keys and never change, so every lookup keeps working; the values used
 * to be emoji.
 */
export const CATEGORY_ICONS = {
  'Feeding / Groceries': 'cart',
  'Transport': 'car',
  'Airtime & Data': 'phone',
  'Electricity': 'bolt',
  'Generator': 'fuel',
  'Rent': 'home',
  'Water': 'drop',
  'Work Expenses': 'case',
  'Courses & Learning': 'book',
  'Tools & Software': 'laptop',
  'Equipment': 'repair',
  'Pharmacy': 'pill',
  'Hospital / Clinic': 'clinic',
  'Personal Care': 'user',
  'Family Support': 'users',
  'Social Events': 'music',
  'Church / Mosque': 'heart',
  'Ajo / Esusu': 'repeat',
  'Loan Repayment': 'card',
  'Bank Charges': 'bank',
  'Savings Transfer': 'vault',
  'Savings': 'vault',
  'Investment': 'chart',
  'Cash Withdrawal': 'cash',
  'Cash Received': 'cash',
  'Transfer Out': 'arrowOut',
  'Transfer In': 'arrowIn',
  'Clothing & Fashion': 'shirt',
  'Entertainment': 'play',
  'Dining Out': 'plate',
  'Subscriptions': 'repeat',
  'Repairs': 'repair',
  'Miscellaneous': 'box',
  'Uncategorized': 'tag',
}

/**
 * Every glyph name Icon.jsx draws. Duplicated here (tests/icons.test.js keeps
 * the two in step) because this file must stay dependency-free: the Node
 * sync scripts import it, and they cannot load JSX.
 */
export const ICON_NAMES = [
  'home', 'budget', 'ledger', 'goal', 'debt', 'project', 'repair', 'diet', 'settings', 'ask',
  'plus', 'close', 'check', 'chevR', 'chevL', 'chevD', 'chevU', 'edit', 'trash', 'search',
  'filter', 'camera', 'mic', 'eye', 'eyeOff', 'refresh', 'export', 'import', 'link', 'undo',
  'more', 'calendar', 'clock', 'bell', 'info', 'alert', 'lock', 'signout', 'sun', 'moon',
  'cart', 'car', 'phone', 'bolt', 'fuel', 'drop', 'case', 'book', 'laptop', 'pill', 'clinic',
  'user', 'users', 'heart', 'card', 'bank', 'vault', 'chart', 'cash', 'arrowIn', 'arrowOut',
  'shirt', 'play', 'plate', 'repeat', 'box', 'tag',
  'gift', 'plane', 'grad', 'shield', 'bus', 'paw', 'music', 'gym', 'leaf', 'game',
]

const ICON_SET = new Set(ICON_NAMES)

/**
 * Emoji that goals.icon and categories.icon held before the glyph set, mapped
 * to the nearest glyph. Keyed by the emoji's first code point, written as an
 * escape so no literal emoji appears in source. No migration: old rows
 * resolve through this, new writes store glyph names.
 */
export const LEGACY_ICON_MAP = {
  // Built-in category icons
  '\u{1F6D2}': 'cart', '\u{1F697}': 'car', '\u{1F4F1}': 'phone', '\u{26A1}': 'bolt',
  '\u{26FD}': 'fuel', '\u{1F3E0}': 'home', '\u{1F4A7}': 'drop', '\u{1F4BC}': 'case',
  '\u{1F4DA}': 'book', '\u{1F4BB}': 'laptop', '\u{1F6E0}': 'repair', '\u{1F48A}': 'pill',
  '\u{1F3E5}': 'clinic', '\u{1F9F4}': 'user', '\u{1F468}': 'users', '\u{1F389}': 'gift',
  '\u{1F64F}': 'heart', '\u{1F91D}': 'repeat', '\u{1F4B3}': 'card', '\u{1F3E6}': 'bank',
  '\u{1F416}': 'vault', '\u{1F4C8}': 'chart', '\u{1F3E7}': 'cash', '\u{1F4B5}': 'cash',
  '\u{2197}': 'arrowOut', '\u{2198}': 'arrowIn', '\u{1F455}': 'shirt', '\u{1F3AC}': 'play',
  '\u{1F37D}': 'plate', '\u{1F504}': 'repeat', '\u{1F527}': 'repair', '\u{1F4E6}': 'box',
  '\u{2753}': 'tag',
  // Goal icons
  '\u{1F3AF}': 'goal', '\u{1F4B0}': 'budget', '\u{2708}': 'plane', '\u{1F393}': 'grad',
  '\u{1F6E1}': 'shield',
  // Custom category icons
  '\u{1F3F7}': 'tag', '\u{1F381}': 'gift', '\u{1F43E}': 'paw', '\u{1F37C}': 'heart',
  '\u{1F68C}': 'bus', '\u{1F6F5}': 'car', '\u{1F9FE}': 'ledger', '\u{1F3A8}': 'edit',
  '\u{1F3CB}': 'gym', '\u{2702}': 'user', '\u{1F9F9}': 'home', '\u{1F331}': 'leaf',
  '\u{1F488}': 'user', '\u{1F37A}': 'plate', '\u{1F3AE}': 'game', '\u{1F9F8}': 'gift',
  '\u{1FA7A}': 'clinic', '\u{1F9F3}': 'plane', '\u{1F4F7}': 'camera', '\u{1F3B5}': 'music',
}

/** True for a name Icon.jsx can draw. */
export function isIconName(value) {
  return typeof value === 'string' && ICON_SET.has(value)
}

/**
 * A stored icon value to a glyph name. A known glyph name is returned as is,
 * a legacy emoji is mapped, anything else gives the fallback (`tag` for
 * categories, `goal` for goals). A raw stored value is never rendered.
 *
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveIcon(value, fallback = 'tag') {
  if (isIconName(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const first = String.fromCodePoint(value.trim().codePointAt(0))
    if (LEGACY_ICON_MAP[first]) return LEGACY_ICON_MAP[first]
  }
  return fallback
}

export const ALL_CATEGORIES = Object.values(CATEGORIES).flat()

// Icons for names that only exist at runtime -- the user's custom categories
// (src/lib/categories.js). Registered rather than imported, because that
// module imports this one, and this file must stay dependency-free for the
// sync scripts that load it under Node.
let runtimeIcons = {}

/** Replace the runtime icon set. Called by categories.js on every load. */
export function registerCategoryIcons(icons) {
  runtimeIcons = { ...(icons || {}) }
}

/**
 * The glyph name for a category: built-ins from CATEGORY_ICONS, custom names
 * from their stored icon (legacy emoji mapped, unknown values to `tag`), and
 * `box` for a name with no icon at all.
 */
export function getCategoryIcon(category) {
  if (CATEGORY_ICONS[category]) return CATEGORY_ICONS[category]
  if (runtimeIcons[category]) return resolveIcon(runtimeIcons[category], 'tag')
  return 'box'
}

/**
 * Curated icon choices for a goal card. Kept separate from CATEGORY_ICONS --
 * a goal names an aim ("Laptop fund", "Ship commits"), not a spending
 * category, so the two lists have no reason to line up.
 */
export const GOAL_ICONS = [
  'goal', 'budget', 'home', 'car', 'plane', 'grad', 'laptop', 'phone', 'shield', 'gift', 'vault', 'chart',
]
