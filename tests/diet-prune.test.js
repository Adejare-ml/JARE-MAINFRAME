import { describe, it, expect } from 'vitest'
import { expiredPhotos, retentionCutoff } from '../src/lib/diet/prune.js'

// Deleting meal photos past diet_settings.photo_retention_days (Phase 3).

const now = new Date('2026-11-10T03:00:00Z')

describe('retentionCutoff', () => {
  it('is now minus the retention, and null (keep everything) when retention is not set', () => {
    expect(retentionCutoff(30, now).toISOString()).toBe('2026-10-11T03:00:00.000Z')
    expect(retentionCutoff(null, now)).toBe(null)
    expect(retentionCutoff(3, now)).toBe(null)
  })
})

describe('expiredPhotos', () => {
  const meals = [
    { id: 'a', photo_path: 'u/2026/09/a.jpg', created_at: '2026-09-01T10:00:00Z', status: 'confirmed' },
    { id: 'b', photo_path: 'u/2026/11/b.jpg', created_at: '2026-11-09T10:00:00Z', status: 'confirmed' },
    { id: 'c', photo_path: null, created_at: '2026-08-01T10:00:00Z', status: 'confirmed' },
    // Still waiting for the owner to check: kept whatever its age.
    { id: 'd', photo_path: 'u/2026/09/d.jpg', created_at: '2026-09-01T10:00:00Z', status: 'auto' },
  ]

  it('lists photos older than the retention, skipping meals with no photo and meals still to check', () => {
    expect(expiredPhotos(meals, 30, now)).toEqual([{ id: 'a', photo_path: 'u/2026/09/a.jpg' }])
  })

  it('lists nothing when retention is not set', () => {
    expect(expiredPhotos(meals, null, now)).toEqual([])
  })
})
