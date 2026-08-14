import { describe, it, expect } from 'vitest'
import { buildRepoProfile, describeRepo, MAX_EVIDENCE_PATHS } from '../src/lib/repoProfile.js'

/**
 * The facts a plan is allowed to be built from.
 *
 * Every one of them has to be checkable by opening the repository, because the
 * planner's whole defence against generic advice is that a suggestion must
 * point at something real. A profile that reports files which are not there,
 * or misses the convention this repo actually uses, quietly moves the goalposts
 * -- a wrong fact passes the citation check just as well as a right one.
 */

const FILES = [
  'src/lib/planning.js',
  'src/lib/queries.js',
  'src/lib/constants.js',
  'src/lib/toast.js',
  'src/lib/parsers/gtbank.js',
  'src/lib/parsers/opay.js',
  'src/lib/sync/index.js',
  'src/components/daily/TodayList.jsx',
  'src/pages/Goals.jsx',
  'scripts/gmail-sync.mjs',
  'tests/planning.test.js',
  'tests/queries.test.js',
  'tests/parsers.test.js',
  'README.md',
  'package.json',
]

describe('buildRepoProfile', () => {
  it('counts only logic, not components', () => {
    // Scanning all of src/ makes four fifths of the untested list React
    // components, where no unit test is this codebase's norm rather than a gap
    // -- and a plan built from that spends a month adding render tests to a
    // button.
    const profile = buildRepoProfile(FILES)
    expect(profile.paths).not.toContain('src/pages/Goals.jsx')
    expect(profile.paths).not.toContain('src/components/daily/TodayList.jsx')
  })

  it('finds the modules with no test file', () => {
    const profile = buildRepoProfile(FILES)
    expect(profile.untested).toContain('src/lib/constants.js')
    expect(profile.untested).toContain('src/lib/toast.js')
    expect(profile.untested).toContain('scripts/gmail-sync.mjs')
  })

  it('does not call a module untested because the test is named for its folder', () => {
    // tests/parsers.test.js covers both parsers, and they have the most
    // thorough tests in the suite. Reporting them as untested would put a
    // month's plan behind a claim anyone could disprove in one click.
    const profile = buildRepoProfile(FILES)
    expect(profile.untested).not.toContain('src/lib/parsers/gtbank.js')
    expect(profile.untested).not.toContain('src/lib/parsers/opay.js')
  })

  it('does not propose work on a barrel file', () => {
    // An index re-exports. There is nothing in it to test, and suggesting
    // otherwise would burn a week of the plan.
    const profile = buildRepoProfile(FILES)
    expect(profile.untested).not.toContain('src/lib/sync/index.js')
  })

  it('leaves tested modules out of the untested list', () => {
    const profile = buildRepoProfile(FILES)
    expect(profile.untested).not.toContain('src/lib/planning.js')
    expect(profile.untested).not.toContain('src/lib/queries.js')
  })

  it('ignores generated directories entirely', () => {
    // A plan to work on a file in dist/ is a plan to have the work deleted by
    // the next build.
    const profile = buildRepoProfile([...FILES, 'dist/assets/index-abc.js', 'node_modules/react/index.js'])
    expect(profile.paths.some((p) => p.startsWith('dist/'))).toBe(false)
    expect(profile.paths.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('reports languages by how much there is of each', () => {
    const profile = buildRepoProfile(FILES)
    expect(profile.languages[0].ext).toBe('.js')
    expect(profile.languages[0].count).toBeGreaterThan(1)
  })

  it('caps the evidence list', () => {
    // A model handed four hundred paths cites the first one it sees.
    const many = Array.from({ length: 200 }, (_, i) => `src/lib/mod${i}.js`)
    expect(buildRepoProfile(many).paths.length).toBeLessThanOrEqual(MAX_EVIDENCE_PATHS)
  })

  it('puts the untested ones first, since those are the ones with a story', () => {
    const profile = buildRepoProfile(FILES)
    const firstTested = profile.paths.findIndex((p) => !profile.untested.includes(p))
    const lastUntested = profile.paths.reduce(
      (acc, p, i) => (profile.untested.includes(p) ? i : acc),
      -1,
    )
    expect(lastUntested).toBeLessThan(firstTested === -1 ? Infinity : firstTested)
  })

  it('survives junk in the file list', () => {
    const profile = buildRepoProfile([null, '', 42, 'src/lib/ok.js', undefined])
    expect(profile.untested).toEqual(['src/lib/ok.js'])
  })

  it('survives no files at all', () => {
    const profile = buildRepoProfile([])
    expect(profile).toMatchObject({ sourceCount: 0, testCount: 0, untested: [], paths: [] })
  })
})

describe('describeRepo', () => {
  it('lists each citable path on its own line, exactly as it must be copied', () => {
    // The citation rule depends on exact copying, and a numbered list is the
    // form a model copies from most reliably -- the same shape as the
    // categorization prompt, which is the one prompt here with a proven hit
    // rate.
    const text = describeRepo(buildRepoProfile(FILES))
    expect(text).toContain('- src/lib/constants.js')
    for (const line of text.split('\n').filter((l) => l.startsWith('- '))) {
      expect(line).toMatch(/^- \S+( {2}\(no test file\))?$/)
    }
  })

  it('marks which ones have no test', () => {
    const text = describeRepo(buildRepoProfile(FILES))
    expect(text).toMatch(/src\/lib\/constants\.js {2}\(no test file\)/)
    expect(text).not.toMatch(/src\/lib\/planning\.js {2}\(no test file\)/)
  })

  it('says how much there is, so a plan is not made in the dark', () => {
    expect(describeRepo(buildRepoProfile(FILES))).toMatch(/\d+ source files .*\d+ test files/)
  })
})
