/**
 * Custom categories: the user's own names, merged with the built-in list.
 *
 * `category` is plain text on every row (013 put no check constraint on
 * it), so a custom name is an app-level idea: one `categories` row per
 * name (migration 030), folded into the pickers here. A module-level store
 * like schema.js, for the same reason: the list is global, read inside
 * plain render code, and set once per session -- and again whenever the
 * Settings section changes it.
 *
 * What is deliberately NOT here: the model. batchPrompt.js still offers the
 * built-in list only, and normalize.js still folds anything else to
 * Uncategorized, so the sync never invents a name. A custom name reaches a
 * synced row through a Category Rule (applied after validation, verbatim --
 * see scripts/gmail-sync.mjs) or a manual edit in the ledger.
 */
import { CATEGORIES, ALL_CATEGORIES, registerCategoryIcons } from './constants.js'

/** The heading a custom category sits under unless it names a built-in one. */
export const CUSTOM_SECTION = 'Custom'

/** Matches the check constraint in 030: a category is a label, not a sentence. */
export const NAME_MAX = 40

/** Icon choices for a new category. Kept apart from GOAL_ICONS: a
 *  category names a kind of spending, not an aim. */
export const CUSTOM_CATEGORY_ICONS = [
  '🏷️', '🎁', '🐾', '🍼', '🚌', '🛵', '🧾', '🎨', '🏋️', '✂️',
  '🧹', '🌱', '💈', '🍺', '🎮', '🧸', '🩺', '🧳', '📷', '🎵',
]

let custom = []

/** Case-insensitive, trimmed comparison key. */
const keyOf = (name) => String(name || '').trim().toLowerCase()

/**
 * True for a name on the built-in list, whatever its case. A custom
 * category may not shadow one: two "Transport" entries in a picker is a
 * bug report waiting to happen, and summary.js keys its transfer logic on
 * the built-in spellings.
 */
export function isBuiltIn(name) {
  const key = keyOf(name)
  return ALL_CATEGORIES.some((c) => c.toLowerCase() === key)
}

function normalise(rows) {
  const out = []
  const seen = new Set()
  for (const row of rows || []) {
    const name = typeof row?.name === 'string' ? row.name.trim() : ''
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key) || isBuiltIn(name)) continue
    seen.add(key)
    const section = typeof row.section === 'string' && row.section.trim() ? row.section.trim() : CUSTOM_SECTION
    const icon = typeof row.icon === 'string' && row.icon.trim() ? row.icon.trim() : null
    out.push({ id: row.id ?? null, name, section, icon })
  }
  return out
}

/**
 * Replace the store with these rows. Blank names, duplicates (by case) and
 * anything shadowing a built-in are dropped rather than trusted -- the
 * database refuses them too (030), but rows from before it might not have.
 * Icons are registered with constants.js so getCategoryIcon, which every
 * row and chip already calls, answers for custom names without a second
 * lookup path.
 */
export function setCustomCategories(rows) {
  custom = normalise(rows)
  registerCategoryIcons(Object.fromEntries(custom.filter((c) => c.icon).map((c) => [c.name, c.icon])))
}

/** Back to built-ins only: sign-out, and tests. */
export function resetCustomCategories() {
  setCustomCategories([])
}

/** The custom rows as loaded, copies. */
export function customCategories() {
  return custom.map((c) => ({ ...c }))
}

/** True for a name in the custom store, whatever its case. */
export function isCustom(name) {
  const key = keyOf(name)
  return custom.some((c) => c.name.toLowerCase() === key)
}

/**
 * The picker's sections: every built-in section as constants.js has it,
 * then custom names under their own heading -- or appended to a built-in
 * section when their `section` names one, so "Pets" can sit under Personal.
 */
export function groupedCategories() {
  const grouped = {}
  for (const [section, names] of Object.entries(CATEGORIES)) grouped[section] = [...names]
  for (const c of custom) {
    if (!grouped[c.section]) grouped[c.section] = []
    grouped[c.section].push(c.name)
  }
  return grouped
}

/** Every name a picker may offer: built-ins first, then custom, in load order. */
export function allCategories() {
  return [...ALL_CATEGORIES, ...custom.map((c) => c.name)]
}

/**
 * Whether a proposed name can be saved.
 *
 * @param {string} raw - what was typed
 * @param {Array<{name: string}>} [existing] - the custom rows to check against; the store by default
 * @returns {{ok: true, name: string} | {ok: false, error: string}}
 */
export function validateCategoryName(raw, existing = custom) {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  if (!name) return { ok: false, error: 'Give it a name' }
  if (name.length > NAME_MAX) return { ok: false, error: `Keep it to ${NAME_MAX} characters` }
  if (isBuiltIn(name)) return { ok: false, error: `${name} is already a built-in category` }
  const key = name.toLowerCase()
  if ((existing || []).some((c) => keyOf(c?.name) === key)) {
    return { ok: false, error: `You already have ${name}` }
  }
  return { ok: true, name }
}
