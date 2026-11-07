/**
 * The judgment in the weekly backup (scripts/backup.mjs), kept pure so it
 * can be tested without GitHub or a database.
 *
 * Three things went wrong, or would have:
 * - the script refused only the app's own repository as a target, so a
 *   backup repository created with the default visibility (public) would
 *   have received the whole ledger, raw bank emails included, every week;
 * - it read a file's sha with GitHub's default media type, which the
 *   contents API refuses for blobs over 1 MB, so the first week the bundle
 *   passed 1 MB latest.json would have stopped updating and the job gone
 *   permanently red;
 * - it wrote both files before checking the ledger was in the bundle, so a
 *   transient read error on transactions would have overwritten the
 *   restore pointer with a ledger-less copy.
 */

/**
 * Whether a repository is a safe place for the bundle: private, and not
 * the app's own (public) repository, whatever its visibility says.
 *
 * @param {{private?: boolean, full_name?: string}|null} repo - GET /repos/{owner}/{name}
 * @param {string} [thisRepo] - GITHUB_REPOSITORY of the running workflow
 */
export function isSafeBackupTarget(repo, thisRepo = '') {
  if (!repo || repo.private !== true) return false
  const name = String(repo.full_name || '').toLowerCase()
  if (thisRepo && name && name === String(thisRepo).toLowerCase()) return false
  return true
}

/** Why isSafeBackupTarget said no, in words for the log and the issue. */
export function unsafeTargetReason(repo, thisRepo = '') {
  if (!repo) return 'the repository could not be read (does the token have Metadata: read on it?)'
  if (repo.private !== true) return `${repo.full_name || 'the repository'} is public; the backup holds every transaction and must go to a private repository`
  if (thisRepo && String(repo.full_name || '').toLowerCase() === String(thisRepo).toLowerCase()) {
    return `${repo.full_name} is this repository, which is public`
  }
  return 'the repository is not a safe target'
}

/**
 * Request headers for the GitHub contents API.
 *
 * The `object` media type answers a lookup with the file's sha and no
 * content at any size up to 100 MB; the default JSON type refuses blobs
 * over 1 MB. Writes use the default type.
 *
 * @param {string} token
 * @param {{purpose?: 'lookup'|'write'}} [options]
 */
export function contentsHeaders(token, { purpose = 'write' } = {}) {
  return {
    authorization: `Bearer ${token}`,
    accept: purpose === 'lookup' ? 'application/vnd.github.object+json' : 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'jare-mainframe-backup',
  }
}

/**
 * Throws unless the bundle carries the ledger. Called before anything is
 * written: a bundle without transactions is not a backup, however cleanly
 * it was uploaded, and must never become latest.json.
 *
 * @param {{tables?: object, skipped?: Array<{table: string, reason: string}>}} bundle
 */
export function assertBundleHasLedger(bundle) {
  if (bundle && Array.isArray(bundle.tables?.transactions)) return
  const reason = bundle?.skipped?.find((s) => s.table === 'transactions')?.reason || 'unknown'
  throw new Error(`transactions were not read: ${reason}; nothing was written`)
}

/**
 * What the run record should say. A dry run never counts as a backup:
 * Settings → System and the morning digest read the newest row, and a
 * green dry-run row would hide weeks of real failures.
 *
 * @param {{dryRun: boolean, configured: boolean, written: boolean, rowCount?: number, tableCount?: number, kb?: number, target?: string}} facts
 * @returns {{ok: boolean, summary: string}}
 */
export function runRecordFor({ dryRun, configured, written, rowCount = 0, tableCount = 0, kb = 0, target = '' }) {
  if (dryRun) {
    return {
      ok: false,
      summary: `dry run: ${rowCount} rows, ${kb} KB${configured ? ', nothing written' : ', destination not configured'}`,
    }
  }
  if (!configured) {
    return {
      ok: false,
      summary:
        'not configured: BACKUP_REPO / BACKUP_REPO_TOKEN are not set. Create a private repository for the backups and a ' +
        'fine-grained token with Contents read and write on it, then add the variable and the secret (README, "Backups").',
    }
  }
  return {
    ok: written,
    summary: written ? `${rowCount} rows across ${tableCount} tables, ${kb} KB → ${target}` : 'nothing written',
  }
}
