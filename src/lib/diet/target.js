/**
 * Diet: recomputing the daily target from the latest weight.
 *
 * Every 14 days (Phase 4 shows the proposal; the arithmetic is here and
 * tested from Phase 1): maintenance from Mifflin-St Jeor at activity factor
 * 1.375, then a proposed target that keeps the current gap below
 * maintenance, rounded to the nearest 50 kcal and never below 1,800 kcal.
 * The owner accepts or rejects it; nothing changes on its own.
 *
 * "Keeps the current gap" is this build's reading of the spec, which gives
 * the formula and the floor but not the deficit (docs/diet-module.md,
 * section 7, point 11). The gap is measured against maintenance at the
 * weight stored in diet_settings, which is the weight the current target
 * was set at; accepting a proposal moves that weight forward with it.
 *
 * Exercise never adds calories back. Activity is in the factor, once, and
 * no function here takes exercise as an input.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { toNumber } from './nutrition.js'

export const KCAL_FLOOR = 1800
export const REVIEW_DAYS = 14
export const DEFAULT_ACTIVITY = 1.375

/**
 * Basal metabolic rate, Mifflin-St Jeor (1990):
 * 10 x kg + 6.25 x cm - 5 x age, + 5 for men, - 161 for women.
 */
export function bmr({ weightKg, heightCm, age, sex }) {
  const w = toNumber(weightKg)
  const h = toNumber(heightCm)
  const a = toNumber(age)
  if (!w || !h || a == null || (sex !== 'male' && sex !== 'female')) return null
  return 10 * w + 6.25 * h - 5 * a + (sex === 'male' ? 5 : -161)
}

/** BMR times the activity factor; null when BMR cannot be computed. */
export function maintenance({ activityFactor = DEFAULT_ACTIVITY, ...body }) {
  const b = bmr(body)
  if (b == null) return null
  return b * (toNumber(activityFactor) || DEFAULT_ACTIVITY)
}

/**
 * Age from a birth year. Without the birthday itself it can be a year
 * high for part of the year; at 5 kcal a year that is inside the rounding
 * to 50 kcal the proposal applies anyway.
 */
export function ageIn(birthYear, now = new Date()) {
  const y = toNumber(birthYear)
  if (!y) return null
  return now.getFullYear() - y
}

/**
 * @param {object} args
 * @param {object} args.settings - the diet_settings row
 * @param {number} args.latestWeightKg - the newest weight_logs entry
 * @param {Date} [args.now]
 * @returns {{kcal_target: number, maintenance: number, previous_target: number, weight_kg: number}|null}
 */
export function proposeTarget({ settings, latestWeightKg, now = new Date() }) {
  const age = ageIn(settings?.birth_year, now)
  const body = { heightCm: settings?.height_cm, age, sex: settings?.sex, activityFactor: settings?.activity_factor }
  const current = toNumber(settings?.kcal_target)
  const latest = toNumber(latestWeightKg)
  const then = maintenance({ ...body, weightKg: settings?.weight_kg })
  const nowMaint = maintenance({ ...body, weightKg: latest })
  if (!current || then == null || nowMaint == null) return null
  const gap = then - current
  const proposed = Math.max(KCAL_FLOOR, Math.round((nowMaint - gap) / 50) * 50)
  return { kcal_target: proposed, maintenance: Math.round(nowMaint), previous_target: current, weight_kg: latest }
}

/** True when 14 days have passed since the last review, or there has never been one. */
export function reviewDue(reviewedAt, now = new Date()) {
  if (!reviewedAt) return true
  const t = new Date(reviewedAt).getTime()
  if (Number.isNaN(t)) return true
  return now.getTime() - t >= REVIEW_DAYS * 24 * 60 * 60 * 1000
}
