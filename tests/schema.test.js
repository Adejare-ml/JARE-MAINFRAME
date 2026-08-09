import { describe, it, expect, beforeEach } from 'vitest'
import {
  GATED_COLUMNS,
  isMissingColumnError,
  setSchemaCapabilities,
  resetSchemaCapabilities,
  hasColumn,
  pendingMigrations,
  probeSchema,
} from '../src/lib/schema.js'
import { transactionListColumns, transactionSummaryColumns } from '../src/lib/queries.js'

beforeEach(() => resetSchemaCapabilities())

describe('isMissingColumnError', () => {
  it('recognises the exact error that took production down', () => {
    // Verbatim from the live app: "column transactions.explanation does not exist"
    expect(
      isMissingColumnError({
        code: '42703',
        message: 'column transactions.explanation does not exist',
      }),
    ).toBe(true)
  })

  it('recognises the write-side variant', () => {
    // PostgREST reports a missing column on insert/update as PGRST204 rather
    // than a Postgres code, so matching only 42703 would let every sync insert
    // fail unhandled.
    expect(isMissingColumnError({ code: 'PGRST204' })).toBe(true)
  })

  it('matches on message alone when no code is present', () => {
    expect(isMissingColumnError({ message: 'column "voided" does not exist' })).toBe(true)
  })

  it('does not claim a missing function is a missing column', () => {
    // The two take different recovery paths, so conflating them sends the app
    // down a fallback built for the wrong problem.
    expect(
      isMissingColumnError({
        code: 'PGRST202',
        message: 'Could not find the function public.correct_transaction in the schema cache',
      }),
    ).toBe(false)
  })

  it('does not swallow unrelated failures', () => {
    // If a permission error or a dropped connection were read as "column
    // missing", the app would silently narrow every query for the session and
    // quietly show less data than exists.
    expect(isMissingColumnError({ code: '42501', message: 'permission denied' })).toBe(false)
    expect(isMissingColumnError({ message: 'Failed to fetch' })).toBe(false)
    expect(isMissingColumnError({ code: '42P01', message: 'relation "debts" does not exist' })).toBe(false)
    expect(isMissingColumnError(null)).toBe(false)
  })
})

describe('capability store', () => {
  it('treats everything as present before a probe runs', () => {
    expect(hasColumn('transactions.explanation')).toBe(true)
    expect(pendingMigrations()).toEqual([])
  })

  it('maps a missing column to the file that creates it', () => {
    setSchemaCapabilities(['transactions.explanation'])
    expect(hasColumn('transactions.explanation')).toBe(false)
    expect(pendingMigrations()).toEqual(['005_llm_categorization.sql'])
  })

  it('lists each migration once even when it owns several columns', () => {
    setSchemaCapabilities(Object.keys(GATED_COLUMNS))
    expect(pendingMigrations()).toEqual([...new Set(Object.values(GATED_COLUMNS))].sort())
  })
})

describe('gated column lists', () => {
  it('asks for explanation when the database has it', () => {
    expect(transactionListColumns()).toContain('explanation')
  })

  it('omits explanation when it is missing -- this is the outage fix', () => {
    setSchemaCapabilities(['transactions.explanation'])
    const columns = transactionListColumns()
    expect(columns).not.toContain('explanation')
    // Everything else must survive: dropping the whole list would be a
    // different way of showing nothing.
    for (const required of ['id', 'type', 'amount', 'category', 'transaction_date', 'reviewed']) {
      expect(columns).toContain(required)
    }
  })

  it('never selects raw_email, gated or not', () => {
    setSchemaCapabilities(['transactions.explanation'])
    expect(transactionListColumns()).not.toContain('raw_email')
    expect(transactionSummaryColumns()).not.toContain('raw_email')
  })

  it('leaves the summary list alone -- it names no gated column', () => {
    const before = transactionSummaryColumns()
    setSchemaCapabilities(['transactions.explanation'])
    expect(transactionSummaryColumns()).toBe(before)
  })

  it('emits a comma-separated list PostgREST can parse', () => {
    setSchemaCapabilities(['transactions.explanation'])
    // No leading, trailing or doubled commas from filtering something out.
    expect(transactionListColumns()).not.toMatch(/^,|,$|,\s*,/)
  })
})

describe('the registry stays honest', () => {
  it('names a real migration file for every gated column', () => {
    for (const [key, file] of Object.entries(GATED_COLUMNS)) {
      expect(key).toMatch(/^\w+\.\w+$/)
      expect(file).toMatch(/^\d{3}_[\w]+\.sql$/)
    }
  })
})

describe('probeSchema', () => {
  /** A client whose `transactions`/`goals` selects fail for the named columns. */
  function fakeClient(missingColumns, { requests } = { requests: [] }) {
    return {
      from(table) {
        return {
          select(columns) {
            return {
              limit() {
                requests.push(`${table}.${columns}`)
                const asked = columns.split(',').map((c) => c.trim())
                const bad = asked.find((c) => missingColumns.includes(`${table}.${c}`))
                return Promise.resolve(
                  bad
                    ? { error: { code: '42703', message: `column ${table}.${bad} does not exist` } }
                    : { data: [], error: null },
                )
              },
            }
          },
        }
      },
    }
  }

  it('reports nothing missing when the database is up to date', async () => {
    const requests = []
    expect(await probeSchema(fakeClient([], { requests }))).toEqual([])
    expect(hasColumn('transactions.explanation')).toBe(true)
    // One request per table, no per-column follow-up. This is the common case
    // and it must stay cheap.
    expect(requests).toHaveLength(2)
  })

  it('narrows to the exact missing column', async () => {
    const missing = await probeSchema(fakeClient(['transactions.explanation']))
    expect(missing).toEqual(['transactions.explanation'])
    expect(hasColumn('transactions.explanation')).toBe(false)
    expect(hasColumn('goals.slot')).toBe(true)
    expect(pendingMigrations()).toEqual(['005_llm_categorization.sql'])
  })

  it('assumes present when the probe fails for an unrelated reason', async () => {
    // A 500 or a dropped connection must not silently narrow every query for
    // the rest of the session -- that would show less data than exists and
    // never say why.
    const brokenClient = {
      from: () => ({
        select: () => ({
          limit: () => Promise.resolve({ error: { code: '500', message: 'Internal Server Error' } }),
        }),
      }),
    }
    expect(await probeSchema(brokenClient)).toEqual([])
    expect(hasColumn('transactions.explanation')).toBe(true)
  })
})
