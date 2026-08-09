/**
 * Which parts of the schema actually exist right now.
 *
 * This module exists because of a real outage. Commit 6ac350f added
 * `supabase/migrations/005_llm_categorization.sql` *and* added `explanation` to
 * TRANSACTION_LIST_COLUMNS in the same change. Cloudflare deploys the frontend
 * the moment a commit lands on main; the SQL is run by hand afterwards. So the
 * app went live asking for a column that did not exist yet, PostgREST answered
 * 42703, and because that column list is shared, Daily HQ, Budget and the Ledger
 * all died together — for days, with the only clue being a raw Postgres error
 * printed under "Couldn't load your data".
 *
 * The deploy/migration split is not going away: nothing in a Pages build has, or
 * should have, the credentials to alter the database. What has to change is the
 * consequence. A column the database has not caught up to should cost you that
 * column and a banner telling you which file to run — not the whole ledger.
 */

/**
 * Every column that arrives with a migration rather than the base schema,
 * mapped to the file that creates it.
 *
 * Add a column to a shared select list and you must add it here too. The cost
 * of forgetting is exactly the outage above; the cost of adding it is one line.
 */
export const GATED_COLUMNS = {
  'transactions.explanation': '005_llm_categorization.sql',
  'transactions.voided': '006_transaction_void.sql',
  'goals.slot': '003_goal_slots.sql',
}

/**
 * True when an error means "that column is not there".
 *
 * 42703 is Postgres' undefined_column, which is what a select gets. PGRST204 is
 * PostgREST's "column not found in the schema cache", which is what a write
 * gets. The message pattern is a backstop for older PostgREST builds that
 * returned no code, and is deliberately anchored on the word `column` --
 * a bare /does not exist/ also matches missing *functions*, and conflating the
 * two sends the app down a fallback path built for a different problem.
 *
 * @param {{code?: string, message?: string}} error
 * @returns {boolean}
 */
export function isMissingColumnError(error) {
  if (!error) return false
  if (error.code === '42703' || error.code === 'PGRST204') return true
  return /column .* does not exist|could not find the .* column/i.test(error.message || '')
}

// Module-level rather than React state, and set once per session.
//
// The alternative was threading capabilities through every call site as a prop,
// which for a value that is global, immutable after startup and read inside
// plain (non-component) query builders would be ceremony for its own sake.
// `resetSchemaCapabilities` exists so tests are not order-dependent.
let missing = new Set()
let probed = false

/** Record the probe result. Called once, by probeSchema. */
export function setSchemaCapabilities(missingKeys) {
  missing = new Set(missingKeys)
  probed = true
}

/** Forget everything, so a test starts from a known state. */
export function resetSchemaCapabilities() {
  missing = new Set()
  probed = false
}

/**
 * True when `<table>.<column>` can be selected.
 *
 * Optimistic before the probe finishes: a column absent from GATED_COLUMNS is
 * base schema and always present, and the app never queries before the probe
 * resolves (see probeSchema's placement in App).
 *
 * @param {string} key - e.g. 'transactions.explanation'
 */
export function hasColumn(key) {
  return !missing.has(key)
}

/** The migration files that still need running, deduplicated, in order. */
export function pendingMigrations() {
  return [...new Set([...missing].map((key) => GATED_COLUMNS[key]).filter(Boolean))].sort()
}

/** True once probeSchema has run. Lets the banner stay hidden until we know. */
export function schemaProbed() {
  return probed
}

/**
 * Ask the database which gated columns it actually has.
 *
 * One request per table in the happy path: select every gated column for that
 * table at once, and if it comes back clean they are all present. Only when
 * that fails do we pay for a request per column to find out which ones are
 * missing -- PostgREST names just the first offending column, so a combined
 * probe cannot tell us the whole answer on its own.
 *
 * `.limit(1)` rather than a count: we want PostgREST to validate the column
 * list, which it does whether or not any rows come back, and one row of two
 * columns is as cheap as a request gets.
 *
 * Never throws. A probe that fails for an unrelated reason -- offline, auth,
 * a 500 -- must not decide that columns are missing and silently narrow every
 * query for the rest of the session. In that case we assume present and let the
 * real queries report the real problem.
 *
 * Takes the client rather than importing it, so this whole module stays free of
 * import-time side effects. That is not fastidiousness: `createClient` throws
 * without its env vars, and a module that cannot be imported without a
 * configured backend cannot be unit-tested -- which is precisely how a column
 * list nobody could test in isolation reached production.
 *
 * @param {object} client - the supabase client
 * @returns {Promise<string[]>} the missing keys, also stored for hasColumn
 */
export async function probeSchema(client) {
  const byTable = new Map()
  for (const key of Object.keys(GATED_COLUMNS)) {
    const [table, column] = key.split('.')
    if (!byTable.has(table)) byTable.set(table, [])
    byTable.get(table).push(column)
  }

  const absent = []

  await Promise.all(
    [...byTable.entries()].map(async ([table, columns]) => {
      const { error } = await client.from(table).select(columns.join(', ')).limit(1)
      if (!error) return
      if (!isMissingColumnError(error)) {
        console.warn(`Schema probe on ${table} failed for another reason:`, error.message)
        return
      }

      // At least one is missing; find out precisely which.
      await Promise.all(
        columns.map(async (column) => {
          const { error: one } = await client.from(table).select(column).limit(1)
          if (one && isMissingColumnError(one)) absent.push(`${table}.${column}`)
        }),
      )
    }),
  )

  setSchemaCapabilities(absent)
  if (absent.length > 0) {
    console.warn(
      `Database is behind the app. Missing: ${absent.join(', ')}. ` +
        `Run: ${pendingMigrations().join(', ')}`,
    )
  }
  return absent
}
