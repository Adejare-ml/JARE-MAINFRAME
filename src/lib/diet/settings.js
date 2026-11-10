/**
 * Diet: the settings screen's rules, and the meal split.
 *
 * The owner's measurements, targets and food rules live in one
 * diet_settings row (migration 048), entered on the Diet settings screen.
 * Nothing personal is written into the repo: the repo is public, and the
 * lifestyle skill's rule is that preferences live in the owner's Supabase
 * data. The coach and food-vision prompts (Phases 2 to 4) are filled from
 * this row at call time.
 *
 * Every field is optional. A missing height or birth year costs the target
 * recalculation (./target.js) and nothing else; a missing target costs the
 * rings their fill and the verdicts.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { toNumber } from './nutrition.js'
import { SLOTS } from './totals.js'

/** The spec's default: breakfast 20%, lunch 35%, dinner 30%, snacks 15%. */
export const DEFAULT_SPLIT = Object.freeze({ breakfast: 0.2, lunch: 0.35, dinner: 0.3, snacks: 0.15 })

/** Ranges the screen accepts, mirrored by the check constraints in migration 048. */
export const RANGES = {
  height_cm: [100, 250],
  weight_kg: [30, 400],
  kcal_target: [1000, 6000],
  protein_target_g: [0, 400],
  activity_factor: [1.2, 1.9],
  photo_retention_days: [7, 3650],
}

const LABELS = {
  height_cm: 'Height',
  weight_kg: 'Weight',
  kcal_target: 'Daily kcal target',
  protein_target_g: 'Protein target',
  activity_factor: 'Activity factor',
  photo_retention_days: 'Photo retention',
  birth_year: 'Birth year',
}

/** A stored split, or the default when it is missing or does not add up to the whole day. */
export function parseSplit(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SPLIT }
  const out = {}
  for (const slot of SLOTS) {
    const n = toNumber(value[slot])
    if (n == null || n < 0) return { ...DEFAULT_SPLIT }
    out[slot] = n
  }
  const total = SLOTS.reduce((a, s) => a + out[s], 0)
  return Math.abs(total - 1) < 0.001 ? out : { ...DEFAULT_SPLIT }
}

/** Fractions to whole percentages, for the form. */
export function splitToPercents(split) {
  const s = parseSplit(split)
  return Object.fromEntries(SLOTS.map((slot) => [slot, Math.round(s[slot] * 100)]))
}

/** Whole percentages back to fractions; refused unless they add to 100. */
export function percentsToSplit(percents) {
  const out = {}
  let total = 0
  for (const slot of SLOTS) {
    const n = toNumber(percents?.[slot])
    if (n == null || n < 0 || n > 100) return { ok: false, error: `${slot} needs a share between 0 and 100%` }
    out[slot] = n / 100
    total += n
  }
  if (Math.round(total) !== 100) return { ok: false, error: `The four meals add up to ${Math.round(total)}%, not 100%` }
  return { ok: true, split: out }
}

/** A slot's share of the daily target, in kcal; null without a target. */
export function slotBudget(settings, slot) {
  const target = toNumber(settings?.kcal_target)
  if (!target) return null
  return Math.round(target * parseSplit(settings?.meal_split)[slot])
}

function text(value, max) {
  const s = value == null ? '' : String(value).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

/**
 * The form, checked, as a diet_settings row.
 *
 * @param {object} form - strings as typed, plus `split` as whole percentages
 * @param {Date} [now]
 * @returns {{ok: true, value: object} | {ok: false, errors: Record<string, string>}}
 */
export function validateSettings(form, now = new Date()) {
  const errors = {}
  const value = {}

  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const raw = form?.[key]
    if (raw == null || String(raw).trim() === '') {
      value[key] = null
      continue
    }
    const n = toNumber(raw)
    if (n == null || n < lo || n > hi) {
      errors[key] = `${LABELS[key]} must be between ${lo} and ${hi}`
      continue
    }
    value[key] = key === 'activity_factor' || key === 'weight_kg' || key === 'height_cm' ? n : Math.round(n)
  }

  const by = form?.birth_year
  if (by == null || String(by).trim() === '') {
    value.birth_year = null
  } else {
    const n = toNumber(by)
    const year = now.getFullYear()
    if (n == null || n < 1900 || n > year - 10) errors.birth_year = `${LABELS.birth_year} must be between 1900 and ${year - 10}`
    else value.birth_year = Math.round(n)
  }

  value.sex = form?.sex === 'male' || form?.sex === 'female' ? form.sex : null
  value.display_name = text(form?.display_name, 40)
  value.city = text(form?.city, 60)
  value.substitutes = text(form?.substitutes, 200)
  const avoid = Array.isArray(form?.avoid_foods) ? form.avoid_foods : String(form?.avoid_foods ?? '').split(',')
  value.avoid_foods = avoid.map((s) => text(s, 40)).filter(Boolean).slice(0, 20)

  // Phase 3: the photo models, kept here so a catalogue change is a settings
  // edit, not a deploy. Empty means the default in the diet-photo function.
  for (const key of ['nvidia_vision_model', 'ollama_vision_model']) {
    const id = text(form?.[key], 80)
    if (id && !/^[A-Za-z0-9._:/-]+$/.test(id)) errors[key] = 'A model ID is letters, digits and . _ : / - only'
    else value[key] = id
  }

  const split = percentsToSplit(form?.split ?? splitToPercents(DEFAULT_SPLIT))
  if (!split.ok) errors.split = split.error
  else value.meal_split = split.split

  if (Object.keys(errors).length) return { ok: false, errors }
  return { ok: true, value }
}
