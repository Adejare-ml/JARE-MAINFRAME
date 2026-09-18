/**
 * Fail a scheduled script for the outcome its own error handling cannot see:
 * finishing without throwing, while having done the wrong thing.
 *
 * Each of the four scheduled scripts already has a way to react to something
 * going wrong mid-run -- gmail-sync.mjs accumulates `stats.errors` and keeps
 * going, the others throw and let `main().catch()` exit 1. Neither path fires
 * for a run that reaches the end cleanly having silently not done its job:
 * gmail-sync.mjs prints `stats.errors` but never turns a non-empty array into
 * a non-zero exit code, and a total LLM outage in plan-month.mjs or a dead
 * Google token in draft-day.mjs both currently log a warning and still exit 0.
 * `if: failure()` in every workflow YAML only ever sees a non-zero exit code,
 * so this is the one lever that makes any of these visible at all.
 *
 * Deliberately not a database write or a statistical baseline (that is
 * `sync_runs`, a separate piece) -- this only decides the exit code, from
 * conditions the caller already knows are true or false about its own run.
 *
 * @param {Array<{ ok: boolean, reason: string }>} checks
 */
export function assertProgress(checks) {
  const failed = checks.filter((check) => !check.ok)
  if (failed.length === 0) return

  console.log('─'.repeat(64))
  console.log('🚨 This run finished without throwing, but did not do its job:')
  for (const { reason } of failed) console.log(`   ✗ ${reason}`)

  // Not process.exit(): the caller has already awaited its writes by the time
  // this runs, but a hard exit here would still skip anything after this call
  // in a future version of the script. Setting the code and letting the
  // process end on its own is the same discipline main().catch() already
  // uses one level up.
  process.exitCode = 1
}
