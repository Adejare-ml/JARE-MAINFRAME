/**
 * Leave a note about this run where the app can read it.
 *
 * Every workflow's failure step reaches GitHub; nothing reaches the app,
 * which kept drawing the shape of automation through five weeks in which
 * none of it ran. One sync_runs row per run (migration 025), read by
 * Settings → System. Best-effort by design: a run must never fail because
 * the note about it could not be written, and a database behind 025 costs
 * the note, not the job.
 */

export const RUN_RETENTION_DAYS = 90

/**
 * @param {object} supabase - service-role client
 * @param {{job: string, userId: string, startedAt: Date|number|string, ok: boolean, summary?: string|null}} run
 * @returns {Promise<boolean>} whether the row was written
 */
export async function recordRun(supabase, { job, userId, startedAt, ok, summary = null }) {
  const finished = new Date()
  try {
    const { error } = await supabase.from('sync_runs').insert({
      user_id: userId,
      job,
      started_at: new Date(startedAt).toISOString(),
      finished_at: finished.toISOString(),
      ok: Boolean(ok),
      summary: summary == null ? null : String(summary).slice(0, 500),
    })
    if (error) throw error

    // Six jobs a day for ninety days is a few hundred rows, and the app only
    // ever reads the newest few of each -- older ones say nothing new.
    const cutoff = new Date(finished.getTime() - RUN_RETENTION_DAYS * 86_400_000).toISOString()
    await supabase.from('sync_runs').delete().eq('user_id', userId).eq('job', job).lt('finished_at', cutoff)
    return true
  } catch (err) {
    console.warn(`   (could not record this run in sync_runs: ${err?.message || err})`)
    return false
  }
}
