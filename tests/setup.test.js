import { describe, it, expect } from 'vitest'
import { setupGaps } from '../src/lib/setup.js'
import { STATUS } from '../src/lib/health.js'

const ids = (facts) => setupGaps(facts).map((r) => r.id)

describe('setupGaps', () => {
  it('is empty when every step is done', () => {
    expect(
      setupGaps({
        subscriberCount: 2,
        askStatus: 'reachable',
        mealStatus: 'reachable',
        backupJob: { status: STATUS.OK, report: null },
        pendingMigrations: [],
      }),
    ).toEqual([])
  })

  it('is empty with no facts at all -- unknown is not undone', () => {
    expect(setupGaps()).toEqual([])
    expect(setupGaps({ subscriberCount: null, askStatus: 'checking', mealStatus: 'checking', backupJob: null })).toEqual([])
  })

  it('names the phone step when nobody is subscribed', () => {
    const [row] = setupGaps({ subscriberCount: 0 })
    expect(row.id).toBe('push')
    expect(row.text).toMatch(/No phone is subscribed/)
    expect(row.to).toBe('/settings')
  })

  it('names the backup step from the job report or from a job that never ran', () => {
    expect(ids({ backupJob: { status: STATUS.ATTENTION, report: { setup: true } } })).toEqual(['backup'])
    expect(ids({ backupJob: { status: STATUS.NEVER, report: null } })).toEqual(['backup'])
    expect(ids({ backupJob: { status: STATUS.FAILING, report: null } })).toEqual([])
  })

  it('names the undeployed functions together, and a deployed reader without a key', () => {
    expect(setupGaps({ askStatus: 'unreachable', mealStatus: 'unreachable' })[0].text).toMatch(/^Ask and Meals are not deployed/)
    expect(setupGaps({ askStatus: 'unreachable', mealStatus: 'reachable' })[0].text).toMatch(/^Ask is not deployed/)
    expect(ids({ askStatus: 'reachable', mealStatus: 'nokey' })).toEqual(['meal-key'])
    expect(ids({ askStatus: 'unreachable', mealStatus: 'nokey' })).toEqual(['functions'])
  })

  it('counts pending migrations first, the banner names the files', () => {
    const rows = setupGaps({ pendingMigrations: ['042_meals.sql', '043_discovered_accounts.sql'], subscriberCount: 0 })
    expect(rows.map((r) => r.id)).toEqual(['migrations', 'push'])
    expect(rows[0].text).toMatch(/^2 migrations to run: 042_meals.sql, 043_discovered_accounts.sql/)
  })
})
