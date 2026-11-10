/**
 * Diet: the coach (Phase 4, prompts/coach.md).
 *
 * After a meal whose numbers came from a model (text, voice, photo), the
 * diet-coach edge function asks claude-haiku-5-5 for a verdict and a
 * one-line reason; for saved and hand-picked meals, whose numbers are
 * known, the verdict is computed in code (./verdict.js) and no call is
 * made. "What should I eat next?" sends the same context with no meal.
 *
 * This module builds that context and checks the answer before it is
 * stored or shown:
 *
 *   - The verdict's meaning is fixed by rule (fits / tight / over, see
 *     ./verdict.js), and the numbers are known by the time the coach is
 *     asked, so the rule decides. When the coach agrees, its reason (better
 *     written) is used; when it does not, the rule's verdict and reason
 *     stand and the disagreement is recorded for later comparison.
 *   - Options that name a food the owner avoids, that suggest skipping a
 *     meal, or that have no calories are dropped; at most three are kept,
 *     pantry food first. The prompt says all of this too; this makes it
 *     hold whatever the model answers.
 *   - Em and en dashes are taken out (the prompt asks for none).
 *
 * The coach is also asked to flag patterns in the last days; patternFlag
 * computes the two the prompt names in code, so Today can show them
 * without a call.
 *
 * Pure. Tests: tests/diet-coach.test.js.
 */

import { toNumber, round1, sumNutrition } from './nutrition.js'
import { normaliseName } from './foods.js'
import { localTime, normaliseSlot, addDays } from './totals.js'
import { parseSplit } from './settings.js'

const MODEL_SOURCES = ['text', 'voice', 'photo']

/** True when a meal's verdict should come from the coach rather than from code alone. */
export function needsCoach(meal) {
  return MODEL_SOURCES.includes(meal?.source)
}

/** No em or en dashes: the coach prompt bans them, so nothing shown carries one. */
export function plainText(value, max = 300) {
  return String(value ?? '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

function mealSummary(log) {
  return {
    slot: normaliseSlot(log.meal_slot),
    time: localTime(log.eaten_at),
    kcal: Math.round(toNumber(log.kcal) ?? 0),
    protein_g: round1(log.protein_g),
    items: (log.meal_items || []).map((i) => i.name),
  }
}

/**
 * The JSON the coach prompt's Input section lists.
 *
 * @param {object} args
 * @param {object} args.settings - diet_settings
 * @param {Array} args.todayLogs - today's meal_logs with meal_items
 * @param {Array<{eaten_on: string, kcal: number, protein_g: number}>} args.recent - daily totals, last 7 days
 * @param {string|null} args.mealId - the meal just logged, or null for "what next"
 * @param {string} args.localTime - HH:MM in Lagos
 * @param {Array} args.pantry - pantry_items
 */
export function coachInput({ settings, todayLogs = [], recent = [], mealId = null, localTime: time, pantry = [] }) {
  const kt = toNumber(settings?.kcal_target)
  const pt = toNumber(settings?.protein_target_g)
  const meal = mealId ? todayLogs.find((l) => l.id === mealId) : null
  const others = todayLogs.filter((l) => !meal || l.id !== meal.id)
  const sums = sumNutrition(others)
  const totals = { kcal: sums.kcal, protein_g: sums.protein_g }
  if (meal) {
    if (kt) totals.kcal_left_before_this_meal = Math.round(kt - sums.kcal)
  } else {
    if (kt) totals.kcal_left = Math.round(kt - sums.kcal)
    if (pt) totals.protein_left = Math.max(0, round1(pt - sums.protein_g))
  }
  return {
    settings: { kcal_target: kt ?? null, protein_target_g: pt ?? null, meal_split: parseSplit(settings?.meal_split) },
    today: { meals: others.map(mealSummary), totals },
    recent: [...recent]
      .sort((a, b) => String(a.eaten_on).localeCompare(String(b.eaten_on)))
      .map((d) => ({ date: d.eaten_on, kcal: Math.round(toNumber(d.kcal) ?? 0), protein_g: round1(d.protein_g) })),
    meal: meal ? mealSummary(meal) : null,
    time: time || null,
    pantry: pantry.filter((p) => !p.finished).map((p) => ({ name: p.name, quantity: toNumber(p.quantity), unit: p.unit ?? null })),
  }
}

/**
 * The two patterns the coach prompt names, over the latest three logged
 * days if they are consecutive: three days over target, or protein under
 * 70 g three days running. Null otherwise.
 *
 * @param {Array<{eaten_on: string, kcal: number, protein_g: number}>} recent
 */
export function patternFlag(recent, settings) {
  const days = [...(recent || [])].sort((a, b) => String(a.eaten_on).localeCompare(String(b.eaten_on))).slice(-3)
  if (days.length < 3) return null
  for (let i = 1; i < 3; i++) if (addDays(days[i - 1].eaten_on, 1) !== days[i].eaten_on) return null
  const kt = toNumber(settings?.kcal_target)
  if (kt && days.every((d) => (toNumber(d.kcal) ?? 0) > kt)) return 'Three days in a row over target.'
  if (days.every((d) => (toNumber(d.protein_g) ?? 0) < 70)) return kt ? 'Protein under 70 g for three days running.' : null
  return null
}

function mentionsAny(text, words) {
  const t = ` ${normaliseName(text)} `
  return words.some((w) => {
    const n = normaliseName(w)
    if (!n) return false
    const stem = n.replace(/s$/, '')
    return t.includes(` ${n} `) || t.includes(` ${stem} `) || t.includes(` ${stem}s `)
  })
}

/**
 * The coach's answer, checked.
 *
 * @param {{verdict: string|null, reason: string, next_options: Array, flag: string|null}} answer - validated JSON
 * @param {{hasMeal: boolean, code: {verdict: string|null, reason: string|null}|null, settings: object}} ctx
 */
export function checkCoachAnswer(answer, { hasMeal, code, settings }) {
  const avoid = Array.isArray(settings?.avoid_foods) ? settings.avoid_foods : []
  let verdict = null
  let reason = plainText(answer?.reason)
  let agreed = null
  if (hasMeal) {
    agreed = Boolean(code?.verdict) && answer?.verdict === code.verdict
    if (code?.verdict && !agreed) {
      verdict = code.verdict
      reason = plainText(code.reason)
    } else {
      verdict = code?.verdict ?? null
    }
  }
  const options = (Array.isArray(answer?.next_options) ? answer.next_options : [])
    .filter((o) => o && String(o.meal ?? '').trim())
    .filter((o) => (toNumber(o.kcal) ?? 0) > 0)
    .filter((o) => !/\bskip/i.test(`${o.meal} ${o.why ?? ''}`))
    .filter((o) => !mentionsAny(`${o.meal} ${o.why ?? ''}`, avoid))
    .map((o) => ({
      meal: plainText(o.meal, 160),
      kcal: Math.round(toNumber(o.kcal)),
      protein_g: round1(o.protein_g),
      from_pantry: o.from_pantry === true,
      why: plainText(o.why, 160),
    }))
  options.sort((a, b) => Number(b.from_pantry) - Number(a.from_pantry))
  return {
    verdict,
    reason,
    agreed,
    next_options: options.slice(0, 3),
    flag: answer?.flag ? plainText(answer.flag, 200) : null,
  }
}
