/**
 * Did the code that was planned actually land?
 *
 * Runs on a schedule from .github/workflows/verify-repo.yml. Reads goals whose
 * metric is `repo_commits`, asks GitHub which commits landed in each goal's
 * period, and writes what it found back onto the goal.
 *
 * This exists because of an asymmetry that cannot be designed away. A savings
 * goal measures itself in the browser: the transactions are already loaded, so
 * `goalProgress` recomputes the answer on every render and voiding a
 * transaction moves the figure back the same second. A goal about commits
 * cannot work that way -- answering it means calling GitHub, and putting a
 * token that can read (let alone write) the repository into a bundle served to
 * the public internet is not an option. So the check runs where the credentials
 * already are, and the answer is written down.
 *
 * Three rules govern what it writes, and each of them exists because the
 * obvious alternative is wrong:
 *
 *   Evidence, not a boolean. The SHAs and subjects go into `evidence`, because
 *   the app is asserting something it cannot recompute and therefore has to be
 *   able to show its working. The same reason transactions carry
 *   `direction_source`.
 *
 *   "No signal" is not "not done". A day with no commits is a day with no
 *   commits -- it is not a failure. Office work, reviews and decisions leave no
 *   repo trace at all. The distinction is carried by `verified_at`: null means
 *   nobody looked, and a zero count with a timestamp means somebody looked and
 *   found nothing. Collapsing those two is the same error as reading a sync run
 *   that imported nothing as an empty inbox.
 *
 *   It never writes `completed`. Doneness is decided at render time, and the
 *   tick belongs to the person -- who may well have done the work somewhere a
 *   commit would never show it.
 *
 * All the judgment lives in src/lib/repo.js so it can be tested without a
 * network or a database. This file is wiring.
 */

import { createClient } from '@supabase/supabase-js'
import {
  normalizeCommit,
  commitsByDay,
  commitsInWindow,
  buildEvidence,
  utcWindow,
  LAGOS_OFFSET_MINUTES,
} from '../src/lib/repo.js'
import { periodWindow, REPO_METRIC } from '../src/lib/planning.js'
import { toDateOnly, daysAgo } from '../src/lib/queries.js'

// ───────────────────────────────────────────────────────────────
// 1. Configuration
// ───────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, GITHUB_TOKEN } = process.env

/**
 * The repository being verified.
 *
 * A repository *variable* with a constant fallback, matching how OLLAMA_MODEL
 * and NVIDIA_MODEL are handled -- so pointing this at a second project later is
 * a settings change rather than a code change. The hardcoded list of bank
 * senders that had to be edited and redeployed every time a wallet was added is
 * the lesson being applied early here.
 */
const REPO = process.env.VERIFY_REPO || 'Adejare-ml/JARE-MAINFRAME'

/**
 * Whose commits count. A GitHub login or a commit email; unset means everyone,
 * which is right for a repository with one author.
 */
const AUTHOR = process.env.VERIFY_AUTHOR || null

/** Minutes east of UTC that decide which day a commit belongs to. */
const OFFSET_MINUTES = Number(process.env.VERIFY_TZ_OFFSET_MINUTES) || LAGOS_OFFSET_MINUTES

/**
 * How far back to re-check.
 *
 * More than one day on purpose: a commit pushed late, a run that failed, a
 * laptop that was closed. Re-verifying a fortnight costs one extra page of API
 * results and closes the gap where a missed run leaves a permanent hole.
 */
const VERIFY_DAYS = Number(process.env.VERIFY_DAYS) || 14

/**
 * Whose rows these are.
 *
 * Required, not optional, and that is the whole point. This script writes with
 * the service-role key, which bypasses RLS and has no `auth.uid()` -- so a row
 * it inserts without `user_id` is a row that migration 015's policy makes
 * invisible to you in the app, with no error anywhere. Treating this as
 * optional would turn a missing repository secret into silently vanishing data,
 * which is this project's signature failure.
 *
 * Get it from: select id from auth.users;
 */
const OWNER_USER_ID = process.env.OWNER_USER_ID

const missingVars = [
  ['OWNER_USER_ID', OWNER_USER_ID],
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_SERVICE_KEY', SUPABASE_SERVICE_KEY],
  ['GITHUB_TOKEN', GITHUB_TOKEN],
]
  .filter(([, value]) => !value)
  .map(([name]) => name)

if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

const today = toDateOnly(new Date())
const cutoff = daysAgo(VERIFY_DAYS)

// ───────────────────────────────────────────────────────────────
// 2. GitHub
// ───────────────────────────────────────────────────────────────

/**
 * Every commit in a window, following pagination to the end.
 *
 * Paginated rather than capped at one page, for the same reason the Gmail sync
 * is: a cap that is usually not reached is a bug that only appears on your
 * busiest week, and reports a quiet week instead of an error.
 */
async function fetchCommits({ since, until }) {
  const collected = []
  let page = 1

  while (true) {
    const url =
      `https://api.github.com/repos/${REPO}/commits` +
      `?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}` +
      `&per_page=100&page=${page}`

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'jare-mainframe-verify-repo',
      },
    })

    if (res.status === 404) {
      // Distinguished from a network error because the remedy is different and
      // the symptom is identical: a 404 here almost always means the token
      // cannot see the repository, not that the repository is gone.
      throw new Error(
        `GitHub returned 404 for ${REPO}. Either VERIFY_REPO is wrong or the token cannot see it.`,
      )
    }
    if (!res.ok) {
      throw new Error(`GitHub returned ${res.status} for ${REPO}: ${await res.text()}`)
    }

    const batch = await res.json()
    if (!Array.isArray(batch) || batch.length === 0) break

    collected.push(...batch)
    if (batch.length < 100) break

    page++
    if (page > 20) {
      console.warn('⚠️  Stopped after 2,000 commits; widen the window split if this is real.')
      break
    }
  }

  return collected.map(normalizeCommit).filter(Boolean)
}

// ───────────────────────────────────────────────────────────────
// 3. What changed
// ───────────────────────────────────────────────────────────────

/**
 * Is this the same answer as last time?
 *
 * A run that finds nothing new should cost nothing, exactly as an unchanged day
 * costs the task generator no writes. It also keeps `verified_at` meaning
 * "when this answer was established" rather than "when the cron last ran",
 * which is the more useful of the two and the only one that is not already
 * visible in the Actions log.
 */
function sameEvidence(stored, fresh) {
  if (!stored || typeof stored !== 'object') return false
  if (Number(stored.counted) !== fresh.counted) return false
  if (stored.repo !== fresh.repo || stored.from !== fresh.from || stored.to !== fresh.to) {
    return false
  }

  const before = (stored.commits || []).map((c) => c.sha).join(',')
  const after = fresh.commits.map((c) => c.sha).join(',')
  return before === after
}

// ───────────────────────────────────────────────────────────────
// 4. Run
// ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔍 Verifying ${REPO}`)
  console.log(`   window: ${cutoff} → ${today} (UTC${OFFSET_MINUTES >= 0 ? '+' : ''}${OFFSET_MINUTES / 60})`)
  if (AUTHOR) console.log(`   author: ${AUTHOR}`)

  // A monthly goal is anchored to the 1st of its month, so on the 20th its
  // target_date is nineteen days behind the cutoff even though its window is
  // still open. The prefilter therefore reaches a month further back than the
  // cutoff, and the real test is whether the goal's own period overlaps the
  // window -- which needs periodWindow, and so cannot be done in SQL.
  const { data: rows, error } = await supabase
    .from('goals')
    .select('id, title, period, target_date, target_amount, evidence, verified_at')
    .eq('metric', REPO_METRIC)
    .gte('target_date', daysAgo(VERIFY_DAYS + 31))

  if (error) throw error

  const goals = (rows || [])
    .map((goal) => ({ goal, window: periodWindow(goal) }))
    .filter(({ window }) => window && window.to >= cutoff && window.from <= today)

  if (goals.length === 0) {
    console.log('\nNo repo goals with an open period. Nothing to verify.')
    return
  }

  // One fetch covering every goal's window, rather than one per goal: a monthly
  // goal and the daily tasks under it overlap almost entirely, so per-goal
  // requests would ask GitHub the same question thirty times.
  const from = goals.map(({ window }) => window.from).sort()[0]
  const to = goals.map(({ window }) => (window.to > today ? today : window.to)).sort().at(-1)

  // A day of slack on the request, none on the answer. GitHub filters
  // `since`/`until` by committer date and this buckets by author date, so a
  // commit written at 23:50 and pushed after midnight sits one day outside an
  // exact request. The extra results are discarded by commitsInWindow, which
  // works on author dates and is what actually decides.
  const commits = await fetchCommits(
    utcWindow({ from, to, offsetMinutes: OFFSET_MINUTES, marginDays: 1 }),
  )
  const byDay = commitsByDay(commits, { author: AUTHOR, offsetMinutes: OFFSET_MINUTES })

  console.log(`\n📦 ${commits.length} commit(s) fetched, ${byDay.size} day(s) with work\n`)

  let written = 0
  let unchanged = 0
  const report = []

  for (const { goal, window } of goals) {
    // Never past today. A monthly goal's window runs to the 31st, and counting
    // "commits so far this month" against a target for the whole month is the
    // right comparison; pretending to have checked days that have not happened
    // is not.
    const end = window.to > today ? today : window.to
    const found = commitsInWindow(byDay, { from: window.from, to: end })
    const evidence = buildEvidence(found, { repo: REPO, from: window.from, to: end })

    if (sameEvidence(goal.evidence, evidence) && goal.verified_at) {
      unchanged++
      report.push({ goal, evidence, wrote: false })
      continue
    }

    const { error: writeError } = await supabase
      .from('goals')
      .update({ verified_at: new Date().toISOString(), evidence })
      .eq('id', goal.id)

    if (writeError) throw writeError

    written++
    report.push({ goal, evidence, wrote: true })
  }

  // ── Report ──
  console.log('─'.repeat(64))
  for (const { goal, evidence, wrote } of report) {
    const target = Number(goal.target_amount) || 0
    // "0 of 2 — no signal" rather than "0 of 2 — missed". The verifier knows
    // what landed in the repository and nothing whatsoever about the day.
    const verdict =
      evidence.counted >= target && target > 0
        ? '✅ met'
        : evidence.counted === 0
          ? '· no repo signal'
          : '◐ partial'

    console.log(
      `${verdict.padEnd(18)} ${goal.period.padEnd(8)} ${evidence.from}→${evidence.to}  ` +
        `${evidence.counted}/${target}  ${wrote ? '(written)' : '(unchanged)'}  ${goal.title}`,
    )
  }
  console.log('─'.repeat(64))
  console.log(`\n✅ ${written} goal(s) updated, ${unchanged} unchanged`)
  console.log('   Days with no commits are recorded as checked-and-empty, not as missed.')
}

main().catch((err) => {
  console.error('❌ Repo verification failed:', err?.message || err)
  process.exit(1)
})
