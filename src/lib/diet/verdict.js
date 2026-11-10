/**
 * Diet: does this meal fit?
 *
 * The rules, from the coach prompt and docs/diet-module.md (section 3):
 *
 *   fits   the slot, this meal included, stays inside its share of the day
 *   tight  the slot goes past its share, but the day can still end under
 *          the target (landing exactly on it counts as still under)
 *   over   the day can no longer end under the target
 *
 * Computed here, in code, for a meal whose numbers are already known (a
 * saved meal, a hand-picked entry), so it costs no model call. In Phase 4
 * the coach answers for photo and text meals; this function is the check
 * its answer is compared against.
 *
 * The reason is written the way the coach prompt asks: plain sentences,
 * real numbers, no em dashes.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { toNumber } from './nutrition.js'
import { SLOT_LABELS, normaliseSlot } from './totals.js'
import { slotBudget } from './settings.js'

const fmt = (n) => Math.round(n).toLocaleString('en-US')

function describeMeal(meal) {
  const kcal = toNumber(meal?.kcal) ?? 0
  const protein = toNumber(meal?.protein_g)
  return protein != null ? `${fmt(kcal)} kcal and ${fmt(protein)} g protein.` : `${fmt(kcal)} kcal.`
}

/**
 * @param {object} args
 * @param {{kcal_target?: number, meal_split?: object}} args.settings
 * @param {string} args.slot - breakfast | lunch | dinner | snacks
 * @param {{kcal: number, protein_g?: number}} args.meal - the meal being judged
 * @param {Array<{meal_slot: string, kcal: number}>} args.earlier - the day's other meals, this one excluded
 * @returns {{verdict: 'fits'|'tight'|'over'|null, reason: string|null, slotBudget: number|null,
 *   slotTotal: number, dayTotal: number, left: number|null}}
 */
export function mealVerdict({ settings, slot, meal, earlier = [] }) {
  const s = normaliseSlot(slot)
  const kcal = toNumber(meal?.kcal) ?? 0
  const sumOf = (list) => list.reduce((a, l) => a + (toNumber(l?.kcal) ?? 0), 0)
  const slotTotal = sumOf(earlier.filter((l) => normaliseSlot(l?.meal_slot) === s)) + kcal
  const dayTotal = sumOf(earlier) + kcal
  const target = toNumber(settings?.kcal_target)
  const budget = slotBudget(settings, s)

  if (!target || budget == null) {
    return { verdict: null, reason: null, slotBudget: null, slotTotal, dayTotal, left: null }
  }

  const left = Math.round(target - dayTotal)
  const head = describeMeal(meal)

  if (left < 0) {
    return { verdict: 'over', reason: `${head} That puts the day ${fmt(-left)} kcal over target.`, slotBudget: budget, slotTotal, dayTotal, left }
  }
  const rest = `Leaves you ${fmt(left)} kcal for the rest of the day.`
  if (slotTotal <= budget) {
    return { verdict: 'fits', reason: `${head} ${rest}`, slotBudget: budget, slotTotal, dayTotal, left }
  }
  const past = `${fmt(slotTotal - budget)} kcal past the ${SLOT_LABELS[s].toLowerCase()} share of ${fmt(budget)}.`
  return { verdict: 'tight', reason: `${head} ${past} ${rest}`, slotBudget: budget, slotTotal, dayTotal, left }
}
