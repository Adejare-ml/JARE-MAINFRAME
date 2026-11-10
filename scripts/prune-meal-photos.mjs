/**
 * Deletes meal photos older than the owner's photo retention (Diet module,
 * Phase 3). Weekly, from .github/workflows/prune-meal-photos.yml.
 *
 * The rule is src/lib/diet/prune.js: nothing is deleted while
 * diet_settings.photo_retention_days is empty, and a meal the owner has not
 * checked yet keeps its photo. Photos go through the Storage API (deleting
 * storage.objects rows in SQL would leave the files behind); the meal keeps
 * its numbers and loses only photo_path.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/prune-meal-photos.mjs [--dry-run]
 */

import { createClient } from '@supabase/supabase-js'
import { expiredPhotos } from '../src/lib/diet/prune.js'
import { resolveOwnerUserId } from './lib/ownerId.mjs'
import { recordRun } from './lib/recordRun.mjs'

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true'
const JOB = 'prune-meal-photos'
const STARTED = new Date()
const BATCH = 100

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })

async function main() {
  const owner = await resolveOwnerUserId(supabase)
  const { data: settings, error: sErr } = await supabase.from('diet_settings').select('photo_retention_days').eq('user_id', owner).maybeSingle()
  if (sErr) throw sErr
  const days = settings?.photo_retention_days ?? null
  if (!days) {
    console.log('Photo retention is not set (Diet settings): nothing to delete.')
    await recordRun(supabase, { job: JOB, userId: owner, startedAt: STARTED, ok: true, summary: 'retention not set' })
    return
  }
  const { data: meals, error } = await supabase
    .from('meal_logs')
    .select('id, photo_path, created_at, status')
    .eq('user_id', owner)
    .not('photo_path', 'is', null)
    .order('created_at')
    .limit(5000)
  if (error) throw error
  const expired = expiredPhotos(meals, days)
  console.log(`${expired.length} photo(s) older than ${days} days${DRY_RUN ? ' (dry run: nothing deleted)' : ''}`)
  if (DRY_RUN || expired.length === 0) {
    await recordRun(supabase, { job: JOB, userId: owner, startedAt: STARTED, ok: true, summary: `${expired.length} expired${DRY_RUN ? ', dry run' : ''}` })
    return
  }
  let removed = 0
  for (let i = 0; i < expired.length; i += BATCH) {
    const batch = expired.slice(i, i + BATCH)
    const { error: rmErr } = await supabase.storage.from('meal-photos').remove(batch.map((m) => m.photo_path))
    if (rmErr) throw rmErr
    const { error: upErr } = await supabase.from('meal_logs').update({ photo_path: null }).in('id', batch.map((m) => m.id))
    if (upErr) throw upErr
    removed += batch.length
  }
  console.log(`✓ deleted ${removed} photo(s)`)
  await recordRun(supabase, { job: JOB, userId: owner, startedAt: STARTED, ok: true, summary: `deleted ${removed}` })
}

main().catch(async (err) => {
  console.error(`❌ ${err?.message || err}`)
  try {
    const owner = await resolveOwnerUserId(supabase)
    await recordRun(supabase, { job: JOB, userId: owner, startedAt: STARTED, ok: false, summary: String(err?.message || err) })
  } catch {
    // recording the failure is best effort
  }
  process.exit(1)
})
