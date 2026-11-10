/**
 * Diet: finding a food by what the owner calls it.
 *
 * The foods table carries a name and aliases (the Nigerian name, a common
 * spelling, the plural). searchFoods ranks foods and recipes against a
 * query for the picker on the Today screen; normaliseName is the same
 * comparison Phases 2 and 3 use to match what a model names ("dodo",
 * "fried plantains") to a row, so the picker and the models agree on what
 * counts as the same food.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { toNumber, round1 } from './nutrition.js'

/** Lowercase, no accents, no punctuation, single spaces. */
export function normaliseName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** 0 exact, 1 prefix, 2 a word starts with it, 3 contains it, null no match. */
function rank(candidate, q) {
  const c = normaliseName(candidate)
  if (!c) return null
  if (c === q) return 0
  if (c.startsWith(q)) return 1
  if (c.split(' ').some((w) => w.startsWith(q))) return 2
  if (c.includes(q)) return 3
  return null
}

/**
 * Foods and recipes matching `query`, best first. An empty query lists
 * everything, recipes first, then foods by name.
 *
 * @param {string} query
 * @param {Array<{id: string, name: string, aliases?: string[]}>} foods
 * @param {Array<{id: string, name: string}>} [recipes]
 * @param {number} [limit]
 * @returns {Array<{kind: 'food'|'recipe', id: string, name: string, row: object, score: number}>}
 */
export function searchFoods(query, foods, recipes = [], limit = 40) {
  const q = normaliseName(query)
  const out = []
  for (const r of recipes || []) {
    const score = q ? rank(r.name, q) : 0
    if (score != null) out.push({ kind: 'recipe', id: r.id, name: r.name, row: r, score })
  }
  for (const f of foods || []) {
    let score = q ? rank(f.name, q) : 1
    if (q) {
      for (const alias of f.aliases || []) {
        const s = rank(alias, q)
        if (s != null && (score == null || s < score)) score = s
      }
    }
    if (score != null) out.push({ kind: 'food', id: f.id, name: f.name, row: f, score })
  }
  out.sort((a, b) => a.score - b.score || (a.kind === b.kind ? 0 : a.kind === 'recipe' ? -1 : 1) || a.name.localeCompare(b.name))
  return out.slice(0, limit)
}

/**
 * The quick choices for how much was eaten: half, one, two and three
 * typical portions, and 100 g.
 *
 * @param {{typical_portion_g?: number, portion_label?: string}} food
 */
export function portionOptions(food) {
  const g = toNumber(food?.typical_portion_g)
  const hundred = { label: '100 g', grams: 100 }
  if (!g || g <= 0) return [hundred]
  const label = food?.portion_label || `${round1(g)} g`
  return [
    { label: `½ × ${label}`, grams: round1(g / 2) },
    { label, grams: round1(g) },
    { label: `2 × ${label}`, grams: round1(g * 2) },
    { label: `3 × ${label}`, grams: round1(g * 3) },
    hundred,
  ]
}
