/**
 * What is actually in the repository, stated as facts a person could check.
 *
 * This is one of the planner's two grounded inputs, and it exists because of a
 * specific temptation. A model asked "what should I work on this month" will
 * happily answer from what people at this stage usually do -- learn Docker,
 * write more tests, contribute to open source -- and every word of it will be
 * plausible, generic, and unfalsifiable. That is the hallucination surface, and
 * this project has already shipped two model behaviours that could never have
 * worked (`enable_thinking` against a retired model, a `MEDIUM` confidence the
 * database always rejected). Both read as sensible right up until they didn't.
 *
 * So the planner is not asked what would be good. It is handed a list of things
 * that are true about this repository -- these files exist, these have no test
 * -- and required to cite one. src/lib/planReview.js throws away anything that
 * cannot.
 *
 * Pure, over a plain list of paths, so the whole thing is testable without a
 * filesystem and cannot quietly start depending on the machine it runs on.
 */

/** Extensions worth counting as source. Everything else is noise in a profile. */
const SOURCE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.ts', '.tsx', '.sql']

/**
 * Directories whose contents are never the subject of a plan.
 *
 * `dist` and `node_modules` are generated, and a plan to work on a generated
 * file is a plan to have the work deleted on the next build.
 */
const IGNORED = ['node_modules/', 'dist/', '.git/', 'coverage/', 'build/']

/** Longest evidence list handed to a model. Beyond this it stops reading. */
export const MAX_EVIDENCE_PATHS = 40

const isIgnored = (path) => IGNORED.some((dir) => path.startsWith(dir) || path.includes(`/${dir}`))

const extensionOf = (path) => {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** `src/lib/planning.js` -> `planning`; `tests/planning.test.js` -> `planning`. */
function moduleName(path) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.test\.[a-z]+$/, '').replace(/\.[a-z]+$/, '')
}

/** `src/lib/parsers/gtbank.js` -> `parsers`. */
function parentDir(path) {
  const parts = path.split('/')
  return parts.length > 1 ? parts[parts.length - 2] : ''
}

/**
 * Turn a file listing into the facts a plan may be built from.
 *
 * The interesting output is `untested`: source modules with no test file of the
 * matching name. It is deliberately a crude rule -- `src/lib/x.js` is covered
 * when `tests/x.test.js` exists, and `src/lib/parsers/gtbank.js` is covered when
 * `tests/parsers.test.js` does -- because those are the two conventions this
 * repository actually follows, and a cleverer rule would be one nobody could
 * check by looking.
 *
 * It errs toward flagging. A module tested from a file matching neither its own
 * name nor its directory's reads as untested here, which produces a suggestion
 * that is wrong rather than one that is invented -- and every suggestion lands
 * as a draft a person approves. That asymmetry is the right one: a wrong draft
 * costs a glance, an invented one costs trust.
 *
 * `src/` as a whole is deliberately NOT the default. Scanning it makes the
 * untested list four fifths React components, where the absence of a unit test
 * is the norm in this codebase rather than a gap -- and a plan built from that
 * would spend a month adding render tests to a button. Logic is where a missing
 * test means something.
 *
 * @param {Array<string>} files - repo-relative paths
 * @param {{sourceDirs?: Array<string>, testDir?: string}} [options]
 * @returns {{sourceCount: number, testCount: number, languages: Array<{ext: string, count: number}>, untested: Array<string>, paths: Array<string>}}
 */
export function buildRepoProfile(
  files,
  { sourceDirs = ['src/lib/', 'scripts/'], testDir = 'tests/' } = {},
) {
  const kept = (files || []).filter((f) => typeof f === 'string' && f && !isIgnored(f))

  const source = kept.filter(
    (f) => sourceDirs.some((dir) => f.startsWith(dir)) && SOURCE_EXTENSIONS.includes(extensionOf(f)),
  )
  const tests = kept.filter((f) => f.startsWith(testDir) && f.includes('.test.'))

  const tested = new Set(tests.map(moduleName))

  const languages = new Map()
  for (const f of source) {
    const ext = extensionOf(f)
    languages.set(ext, (languages.get(ext) || 0) + 1)
  }

  const untested = source
    // Covered by its own name, or by a test named for its directory --
    // tests/parsers.test.js covers every parser, which is how this repo is
    // actually laid out. Missing the second rule reported gtbank.js and
    // opay.js as untested when they have the most thorough tests in the suite.
    .filter((f) => !tested.has(moduleName(f)) && !tested.has(parentDir(f)))
    // An index file re-exports; there is nothing in it to test, and proposing
    // otherwise would burn a week of the plan on a barrel.
    .filter((f) => moduleName(f) !== 'index')
    .sort()

  return {
    sourceCount: source.length,
    testCount: tests.length,
    languages: [...languages.entries()]
      .map(([ext, count]) => ({ ext, count }))
      .sort((a, b) => b.count - a.count),
    untested,
    // Everything the plan is allowed to cite. Capped, because a model handed
    // four hundred paths cites the first one it sees.
    paths: [...untested, ...source.filter((f) => tested.has(moduleName(f)))].slice(
      0,
      MAX_EVIDENCE_PATHS,
    ),
  }
}

/**
 * The profile as the few lines a model is actually given.
 *
 * Written out rather than passed as JSON because the citation rule depends on
 * exact copying, and a numbered list of paths is the form a model copies from
 * most reliably. The same reason the categorization prompt lists categories
 * verbatim and requires them back verbatim -- which is the one prompt in this
 * codebase with a proven hit rate.
 *
 * @param {ReturnType<typeof buildRepoProfile>} profile
 * @returns {string}
 */
export function describeRepo(profile) {
  const langs = profile.languages.map((l) => `${l.count}${l.ext}`).join(', ')

  const lines = [
    `${profile.sourceCount} source files (${langs}), ${profile.testCount} test files.`,
    '',
    'Paths you may cite, copied exactly:',
    ...profile.paths.map((p) => `- ${p}${profile.untested.includes(p) ? '  (no test file)' : ''}`),
  ]

  return lines.join('\n')
}
