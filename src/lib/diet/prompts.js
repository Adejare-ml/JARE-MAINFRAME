/**
 * Diet: filling the prompts with the owner's details, and the catalogue and
 * note the text parser is given.
 *
 * The prompt text itself is in prompts/*.md (copied into ./promptText.js by
 * scripts/build-diet-prompts.mjs). It names no one: the repo is public, so
 * the owner's name, city and food rules come from his diet_settings row at
 * call time, through fillPrompt. A placeholder this file does not know is an
 * error rather than text sent to a model.
 *
 * Added for the Diet module, Phase 2 (docs/diet-module.md).
 */

import { round1, toNumber } from './nutrition.js'

/** The prompt itself: everything after the header's first "---" line. */
export function promptBody(md) {
  const text = String(md ?? '')
  const at = text.search(/^---\s*$/m)
  return (at === -1 ? text : text.slice(at).replace(/^---\s*\n/, '')).trim()
}

function listWords(words) {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}

/** The placeholder values, from a diet_settings row (or nothing). */
export function promptValues(settings) {
  const s = settings || {}
  const city = String(s.city ?? '').trim()
  const avoid = (Array.isArray(s.avoid_foods) ? s.avoid_foods : []).map((w) => String(w).trim()).filter(Boolean)
  const subs = String(s.substitutes ?? '').trim()
  const subject = s.sex === 'female' ? 'She' : s.sex === 'male' ? 'He' : 'They'
  const verb = subject === 'They' ? "don't" : "doesn't"
  const rules = []
  if (avoid.length) rules.push(`${subject} ${verb} eat ${listWords(avoid)}.`)
  if (subs) rules.push(avoid.length ? `Use ${subs} instead.` : `Prefer ${subs}.`)
  return {
    name: String(s.display_name ?? '').trim() || 'the owner',
    location: city ? `${city}, Nigeria` : 'Nigeria',
    food_rules: rules.length ? rules.join(' ') : 'No foods are ruled out.',
  }
}

/** The prompt body with every {{placeholder}} filled. Throws on an unknown one. */
export function fillPrompt(md, settings) {
  const values = promptValues(settings)
  return promptBody(md).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`unknown prompt placeholder {{${key}}}`)
    return values[key]
  })
}

/**
 * The owner's catalogue as plain lines, ids first, for the parser to match
 * against. Deterministic for a given library, so the cached prompt prefix
 * stays byte-identical between calls.
 *
 * @param {ReturnType<import('./library.js').buildLibrary>} lib
 */
export function catalogText(lib) {
  const foods = [...(lib?.foods || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const recipes = [...(lib?.recipes || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const saved = [...(lib?.saved || [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const foodLines = foods.map((f) => {
    const g = toNumber(f.typical_portion_g)
    const portion = g ? `${f.portion_label || 'portion'} = ${round1(g)} g` : ''
    return `${f.id} | ${f.name} | ${(f.aliases || []).join(', ')} | ${Math.round(toNumber(f.kcal_per_100g) ?? 0)} kcal/100 g | ${portion}`.trimEnd()
  })
  const recipeLines = recipes.map((r) => {
    const p = lib.portions?.get(r.id)
    return `${r.id} | ${r.name} | ${p ? `1 portion = ${p.grams} g, ${p.kcal} kcal` : 'no ingredients yet'}`
  })
  const savedLines = saved.map((s) => {
    const parts = (s.items || []).map((ref) => {
      if (ref.recipe_id) return `${round1(ref.portions ?? 1)} portion ${lib.recipesById?.get(ref.recipe_id)?.name ?? 'recipe'}`
      if (ref.food_id) return `${round1(ref.grams)} g ${lib.foodsById?.get(ref.food_id)?.name ?? 'food'}`
      return null
    })
    return `${s.id} | ${s.name} | ${parts.filter(Boolean).join(' + ')}`
  })
  return [
    'Foods (id | name | other names | kcal per 100 g | typical portion):',
    ...foodLines,
    '',
    'Recipes (id | name | one portion):',
    ...(recipeLines.length ? recipeLines : ['(none)']),
    '',
    'Saved meals (id | name | what is in it):',
    ...(savedLines.length ? savedLines : ['(none)']),
  ].join('\n')
}

/** The user turn: the clock and the note, the note fenced off as data. */
export function parseUserMessage({ text, localTime }) {
  const note = String(text ?? '').trim()
  return `Local time: ${localTime || 'unknown'}\n\n<note>\n${note}\n</note>`
}

/**
 * The user turn for a photo (Phase 3): the clock, and the owner's note if
 * there is one, fenced off as data like the text parser's. The photo goes
 * beside it as an image block.
 */
export function visionUserMessage({ note, localTime }) {
  const text = String(note ?? '').trim()
  return [`Local time: ${localTime || 'unknown'}`, text ? `<note>\n${text}\n</note>` : 'No note from the user.', 'Estimate the food in this photo.'].join('\n\n')
}
