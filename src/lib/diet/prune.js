/**
 * Diet: which meal photos are past their retention (Phase 3).
 *
 * Photos older than diet_settings.photo_retention_days are deleted by
 * scripts/prune-meal-photos.mjs; with the setting empty nothing is ever
 * deleted. A meal still 'auto' (the owner has not checked it yet) keeps its
 * photo whatever its age, so "Check" never opens a meal with the photo gone.
 * Deleting a photo leaves the meal and its numbers as they are.
 *
 * Pure, so the rule is tested without storage (tests/diet-prune.test.js).
 */

import { toNumber } from './nutrition.js'

/** The oldest moment kept, or null to keep everything (unset, or under the 7-day minimum the settings allow). */
export function retentionCutoff(days, now = new Date()) {
  const d = toNumber(days)
  if (!d || d < 7) return null
  return new Date(now.getTime() - d * 86_400_000)
}

/**
 * @param {Array<{id: string, photo_path: string|null, created_at: string, status: string}>} meals
 * @returns {Array<{id: string, photo_path: string}>}
 */
export function expiredPhotos(meals, days, now = new Date()) {
  const cutoff = retentionCutoff(days, now)
  if (!cutoff) return []
  return (meals || [])
    .filter((m) => m.photo_path && m.status !== 'auto' && new Date(m.created_at) < cutoff)
    .map((m) => ({ id: m.id, photo_path: m.photo_path }))
}
