/**
 * Diet: a day's totals, what is left of the targets, and the 7-day average.
 *
 * Days are Lagos days. The rest of the app uses the browser's local clock
 * (see ../queries.js, toDateOnly), which on the owner's phone is Lagos; the
 * Diet module pins the zone explicitly instead, because meal_logs.eaten_on
 * is also filled in by the database when a client leaves it out (migration
 * 048), and the database's clock is UTC. A meal at 00:30 on a Lagos morning
 * is 23:30 the day before in UTC; both sides must file it under the same day.
 *
 * Added for the Diet module, Phase 1 (docs/diet-module.md).
 */

import { toNumber, round1, sumNutrition } from './nutrition.js'

export const TIME_ZONE = 'Africa/Lagos'

/** The four slots of a day, in order. meal_split (diet_settings) shares the day between them. */
export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks']

export const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' }
export const SLOT_ICONS = { breakfast: '🌅', lunch: '☀️', dinner: '🌙', snacks: '🍊' }

const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const hourFormat = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' })

function asDate(value) {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** YYYY-MM-DD in Lagos. */
export function localDay(value = new Date()) {
  const d = asDate(value)
  return d ? dayFormat.format(d) : null
}

/** HH:MM (24-hour) in Lagos. */
export function localTime(value) {
  const d = asDate(value)
  return d ? timeFormat.format(d) : ''
}

/** 0..23 in Lagos. */
export function localHour(value = new Date()) {
  const d = asDate(value)
  return d ? Number(hourFormat.format(d)) : 12
}

/** A YYYY-MM-DD string moved by `n` days. Calendar arithmetic, no clock involved. */
export function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return t.toISOString().slice(0, 10)
}

/**
 * Which slot a Lagos clock hour most likely is. The same hours as
 * mealTypeFor in ../meals.js, with "snack" renamed to the spec's "snacks".
 */
export function slotForHour(hour) {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 12
  if (h >= 4 && h <= 10) return 'breakfast'
  if (h >= 11 && h <= 15) return 'lunch'
  if (h >= 18 && h <= 22) return 'dinner'
  return 'snacks'
}

export function normaliseSlot(slot) {
  if (slot === 'snack') return 'snacks'
  return SLOTS.includes(slot) ? slot : 'snacks'
}

/**
 * The day in numbers, overall and per slot.
 *
 * @param {Array<{meal_slot: string, kcal: number, protein_g: number, carbs_g: number, fat_g: number}>} logs - one day's meal_logs
 */
export function dayTotals(logs) {
  const list = (logs || []).filter(Boolean)
  const bySlot = {}
  for (const slot of SLOTS) bySlot[slot] = sumNutrition(list.filter((l) => normaliseSlot(l.meal_slot) === slot))
  return { ...sumNutrition(list), count: list.length, bySlot }
}

/**
 * What is left. kcal is a ceiling and goes negative past it; protein is a
 * floor ("at least"), so what is left of it stops at zero once met.
 *
 * @param {{kcal: number, protein_g: number}} totals
 * @param {{kcal_target?: number|null, protein_target_g?: number|null}} settings
 */
export function remaining(totals, settings) {
  const kcal = toNumber(totals?.kcal) ?? 0
  const protein = toNumber(totals?.protein_g) ?? 0
  const kt = toNumber(settings?.kcal_target)
  const pt = toNumber(settings?.protein_target_g)
  const kcal_left = kt ? Math.round(kt - kcal) : null
  return {
    kcal_left,
    protein_left: pt ? Math.max(0, round1(pt - protein)) : null,
    kcal_ratio: kt ? kcal / kt : null,
    protein_ratio: pt ? protein / pt : null,
    over: kcal_left != null && kcal_left < 0,
    protein_met: pt ? protein >= pt : false,
  }
}

/**
 * The average of the logged days among the seven ending on `endDay`.
 *
 * A day with nothing logged is skipped, not counted as zero: an unlogged
 * day is a gap in the record, and counting it as zero would make a week of
 * forgetting look like a week of fasting. Matches the diet_7day_average
 * view (migration 048).
 *
 * @param {Array<{eaten_on: string, kcal: number, protein_g: number, carbs_g: number, fat_g: number}>} days - daily totals
 * @param {string} endDay - YYYY-MM-DD
 * @returns {{days: number, kcal: number, protein_g: number, carbs_g: number, fat_g: number}|null}
 */
export function sevenDayAverage(days, endDay) {
  const start = addDays(endDay, -6)
  const inWindow = (days || []).filter((d) => d && d.eaten_on >= start && d.eaten_on <= endDay)
  if (inWindow.length === 0) return null
  const sum = (key) => inWindow.reduce((a, d) => a + (toNumber(d[key]) ?? 0), 0)
  const n = inWindow.length
  return {
    days: n,
    kcal: Math.round(sum('kcal') / n),
    protein_g: round1(sum('protein_g') / n),
    carbs_g: round1(sum('carbs_g') / n),
    fat_g: round1(sum('fat_g') / n),
  }
}
