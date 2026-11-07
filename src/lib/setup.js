/**
 * The setup steps the app can see are not done.
 *
 * The owner runs every migration the schema banner names and, for weeks,
 * none of the steps it does not: no phone subscribed to the morning
 * reminder (so a week of digests reached nobody), no backup repository
 * (so the weekly backup records "not configured"), two edge functions
 * never deployed (so Meals and Ask have never answered). A hand step with
 * no banner does not happen. This turns the signals the app already has
 * into rows for the top of Daily HQ's Needs Attention card, in the same
 * voice as the schema banner: the exact step, and where to take it.
 *
 * What cannot be detected from the client stays out: whether the
 * repository is private, whether sign-ups are off.
 *
 * Pure: facts in, rows out.
 */

import { STATUS } from './health.js'

/**
 * @param {object} facts
 * @param {number|null} [facts.subscriberCount] - rows in push_subscriptions; null when unknown (table missing or not read)
 * @param {'checking'|'reachable'|'unreachable'|'nokey'|null} [facts.askStatus] - the ask-question GET probe
 * @param {'checking'|'reachable'|'unreachable'|'nokey'|null} [facts.mealStatus] - the analyze-meal GET probe
 * @param {{status?: string, report?: {setup?: boolean}|null}|null} [facts.backupJob] - the backup entry from summarizeRuns
 * @param {string[]} [facts.pendingMigrations] - from schema.js; listed here only as a count, the banner names the files
 * @returns {Array<{id: string, text: string, to: string, label: string}>}
 */
export function setupGaps({ subscriberCount = null, askStatus = null, mealStatus = null, backupJob = null, pendingMigrations = [] } = {}) {
  const rows = []

  if (Array.isArray(pendingMigrations) && pendingMigrations.length > 0) {
    const n = pendingMigrations.length
    rows.push({
      id: 'migrations',
      text: `${n} migration${n === 1 ? '' : 's'} to run: ${pendingMigrations.join(', ')}`,
      to: '/settings',
      label: 'System →',
    })
  }

  if (subscriberCount === 0) {
    rows.push({
      id: 'push',
      text: 'No phone is subscribed, so the morning reminder reaches nobody. Turn it on under Reminders.',
      to: '/settings',
      label: 'Reminders →',
    })
  }

  if (backupJob && (backupJob.status === STATUS.NEVER || backupJob.report?.setup)) {
    rows.push({
      id: 'backup',
      text:
        backupJob.status === STATUS.NEVER
          ? 'The weekly backup has never run. Create the private backup repository and its token (README, "Backups").'
          : 'Backups are not configured: there is no copy of this ledger anywhere. Create the private backup repository and its token (README, "Backups").',
      to: '/settings',
      label: 'System →',
    })
  }

  const notDeployed = []
  if (askStatus === 'unreachable') notDeployed.push('Ask')
  if (mealStatus === 'unreachable') notDeployed.push('Meals')
  if (notDeployed.length > 0) {
    rows.push({
      id: 'functions',
      text: `${notDeployed.join(' and ')} ${notDeployed.length === 1 ? 'is' : 'are'} not deployed. Run \`supabase functions deploy\` and set OLLAMA_API_KEY (Settings → System has the commands).`,
      to: '/settings',
      label: 'System →',
    })
  } else if (mealStatus === 'nokey') {
    rows.push({
      id: 'meal-key',
      text: 'The meal photo reader is deployed but has no model key: set OLLAMA_API_KEY as a function secret.',
      to: '/settings',
      label: 'System →',
    })
  }

  return rows
}
