/**
 * A weekly copy of the ledger, somewhere other than the database.
 *
 * Runs on a schedule from .github/workflows/backup.yml. Supabase's free
 * tier keeps no backups of its own, so until this existed the only copy of
 * every transaction, goal and debt was the live database, plus whatever
 * the owner last downloaded by hand from Settings → Export. This writes
 * that same export -- the JSON bundle src/lib/export.js builds, every
 * table, raw bank emails included -- to a private GitHub repository the
 * owner creates for it: backups/<date>.json, one file a week, and
 * latest.json overwritten each time. Git history keeps every version.
 *
 * Never the app's own repository: it is public, and the bundle is the
 * owner's whole financial life. The script refuses that target outright.
 *
 * Needs, besides the Supabase secrets every job has:
 *   BACKUP_REPO        owner/name of the private repository (a variable)
 *   BACKUP_REPO_TOKEN  a fine-grained token with Contents read and write
 *                      on that one repository, nothing else (a secret)
 * Without them the run fails and says so, on purpose: a backup that is
 * silently not configured is the failure this exists to prevent.
 *
 * BACKUP_DRY_RUN=1 builds the bundle and prints what would be written.
 */

import { createClient } from '@supabase/supabase-js'
import { EXPORT_TABLES, fetchAll, buildBundle } from '../src/lib/export.js'
import { toDateOnly } from '../src/lib/queries.js'
import { resolveOwnerUserId } from './lib/ownerId.mjs'
import { recordRun } from './lib/recordRun.mjs'
import { assertProgress } from './lib/assertProgress.mjs'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, BACKUP_REPO, BACKUP_REPO_TOKEN } = process.env

/** The branch the files go on. The repository's default unless told otherwise. */
const BRANCH = process.env.BACKUP_BRANCH || 'main'

/** Build and describe, write nothing. */
const DRY_RUN = process.env.BACKUP_DRY_RUN === '1' || process.env.BACKUP_DRY_RUN === 'true'

/** Set by Actions to "owner/repo" of the repository the workflow runs in. */
const THIS_REPO = process.env.GITHUB_REPOSITORY || ''

/** Whose rows these are -- see verify-repo.mjs for why this is resolved
 *  at run time and never guessed. */
let OWNER_USER_ID = process.env.OWNER_USER_ID

const JOB = 'backup'
const RUN_STARTED_AT = new Date()

/** What the run record says, set as main() learns it. */
let runSummary = null

const missingVars = [
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_SERVICE_KEY', SUPABASE_SERVICE_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name)

if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// ───────────────────────────────────────────────────────────────
// 2. Reading
// ───────────────────────────────────────────────────────────────

/**
 * Every row of a table, a page at a time. The service key sees every
 * account's rows; this app has one, and the bundle goes to that owner's
 * own private repository.
 */
const readTable = (table) =>
  fetchAll((from, to) => supabase.from(table.name).select('*').order(table.order, { ascending: true }).range(from, to))

// ───────────────────────────────────────────────────────────────
// 3. Writing
// ───────────────────────────────────────────────────────────────

/** The two targets a run writes: one dated file kept forever, one moving pointer. */
function backupPaths(today) {
  return [`backups/${today}.json`, 'latest.json']
}

/** The one shape BACKUP_REPO may take. */
function isRepoName(value) {
  return /^[\w.-]+\/[\w.-]+$/.test(String(value || ''))
}

const headers = () => ({
  authorization: `Bearer ${BACKUP_REPO_TOKEN}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'jare-mainframe-backup',
})

/**
 * Create or update one file through the contents API. Updating needs the
 * blob's current sha, so a read comes first; a 404 there means "new file".
 */
async function putFile(path, content, message) {
  const url = `https://api.github.com/repos/${BACKUP_REPO}/contents/${path}`

  let sha = null
  const head = await fetch(`${url}?ref=${encodeURIComponent(BRANCH)}`, { headers: headers() })
  if (head.status === 200) {
    sha = (await head.json()).sha
  } else if (head.status !== 404) {
    throw new Error(`GitHub ${head.status} reading ${path}: ${(await head.text()).slice(0, 300)}`)
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers(), 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  })
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} writing ${path}: ${(await res.text()).slice(0, 300)}`)
  }
  return sha ? 'updated' : 'created'
}

// ───────────────────────────────────────────────────────────────
// 4. Run
// ───────────────────────────────────────────────────────────────

async function main() {
  OWNER_USER_ID = await resolveOwnerUserId(supabase, OWNER_USER_ID)
  const today = toDateOnly(new Date())
  console.log(`🗄️  Backup for ${today}${DRY_RUN ? ' (dry run)' : ''}`)

  const bundle = await buildBundle(EXPORT_TABLES, readTable)
  const rowCount = Object.values(bundle.tables).reduce((n, rows) => n + rows.length, 0)
  const tableCount = Object.keys(bundle.tables).length
  console.log(`   ${rowCount} row(s) across ${tableCount} table(s)`)
  for (const skip of bundle.skipped) console.log(`   · skipped ${skip.table}: ${skip.reason}`)

  const json = JSON.stringify(bundle, null, 2)
  const kb = Math.round(Buffer.byteLength(json, 'utf8') / 1024)
  const paths = backupPaths(today)
  const configured = Boolean(BACKUP_REPO && BACKUP_REPO_TOKEN)

  // A dry run proves the reading half without the repository, so the
  // bundle can be checked in the Actions log before the token exists.
  if (DRY_RUN) {
    console.log(
      configured
        ? `Dry run: would write ${kb} KB to ${BACKUP_REPO} as ${paths.join(' and ')}`
        : `Dry run: would write ${kb} KB, but BACKUP_REPO / BACKUP_REPO_TOKEN are not set, so a real run fails here.`,
    )
    runSummary = `dry run: ${rowCount} rows, ${kb} KB${configured ? '' : ', destination not configured'}`
    return
  }

  if (!configured) {
    throw new Error(
      'BACKUP_REPO / BACKUP_REPO_TOKEN are not set. Create a private repository for the backups and a ' +
        'fine-grained token with Contents read and write on it, then add the variable and the secret (README, "Backups").',
    )
  }
  if (!isRepoName(BACKUP_REPO)) {
    throw new Error(`BACKUP_REPO must be owner/name, got "${BACKUP_REPO}"`)
  }
  if (THIS_REPO && BACKUP_REPO.toLowerCase() === THIS_REPO.toLowerCase()) {
    throw new Error(`BACKUP_REPO is this repository (${THIS_REPO}), which is public. The backup holds every transaction; give it a private repository of its own.`)
  }

  for (const path of paths) {
    const outcome = await putFile(path, json, `Backup ${today}`)
    console.log(`   ${outcome} ${path}`)
  }

  runSummary = `${rowCount} rows across ${tableCount} tables, ${kb} KB → ${BACKUP_REPO}/${paths[0]}`
  console.log(`✅ ${runSummary}`)

  // A bundle without the ledger in it is not a backup, however cleanly it
  // was written: transactions is the table this exists for.
  assertProgress([
    {
      ok: Array.isArray(bundle.tables.transactions),
      reason: `transactions were not read: ${bundle.skipped.find((s) => s.table === 'transactions')?.reason || 'unknown'}`,
    },
  ])
}

main()
  .then(() => recordRun(supabase, { job: JOB, userId: OWNER_USER_ID, startedAt: RUN_STARTED_AT, ok: process.exitCode !== 1, summary: runSummary }))
  .catch(async (err) => {
    console.error('❌ Backup failed:', err?.message || err)
    await recordRun(supabase, { job: JOB, userId: OWNER_USER_ID, startedAt: RUN_STARTED_AT, ok: false, summary: err?.message || String(err) })
    process.exit(1)
  })
