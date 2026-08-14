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

  // The cadence columns all arrive together in 009, so one missing means all
  // missing. They are listed individually anyway: `hasColumn` answers per
  // column, and a select list that drops `generated` while still asking for
  // `metric` is the same 42703 by another name.
  'goals.parent_id': '009_goal_cadence.sql',
  'goals.generated': '009_goal_cadence.sql',
  'goals.target_amount': '009_goal_cadence.sql',
  'goals.metric': '009_goal_cadence.sql',
  'goals.metric_category': '009_goal_cadence.sql',
  'goals.metric_wallet_id': '009_goal_cadence.sql',

  // Where the repo verifier writes what it found. These are the one place the
  // app stores an answer it cannot recompute -- the browser has no GitHub
  // credentials -- so a goal that reads them without 010 shows an empty bar and
  // no explanation, which is the worst of both.
  'goals.verified_at': '010_repo_goals.sql',
  'goals.evidence': '010_repo_goals.sql',
  'goals.blocked_reason': '010_repo_goals.sql',

  // The planner's columns. `plan_status` is the load-bearing one: without it
  // there is no way to filter drafts out, and a proposal a model wrote while
  // you slept would appear on Daily HQ as a task you had agreed to.
  'goals.plan_status': '011_month_planner.sql',
  'goals.focus': '011_month_planner.sql',
  'goals.plan_evidence': '011_month_planner.sql',
  'goals.planned_at': '011_month_planner.sql',

  // A whole table rather than a column, which is why probeSchema had to learn
  // about 42P01 above. One key is enough to make the banner name the file;
  // `free_minutes` is listed too because it is the figure the page actually
  // renders, so a partially-applied 012 is caught rather than assumed away.
  'day_briefs.brief_date': '012_day_brief.sql',
  'day_briefs.free_minutes': '012_day_brief.sql',
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

/**
 * True when the whole table is absent, not just a column of it.
 *
 * A different error entirely -- 42P01 from Postgres, PGRST205 from PostgREST's
 * schema cache -- and until 012 the probe treated it as "failed for another
 * reason" and moved on. That was survivable while every gated column lived on a
 * table that already existed. It stops being survivable the moment a migration
 * introduces a table, because the probe would record nothing missing,
 * `hasColumn` would answer true, and the banner that is supposed to name the
 * file you have to run would stay silent about it.
 *
 * @param {{code?: string, message?: string}} error
 */
export function isMissingTableError(error) {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /relation .* does not exist|could not find the table/i.test(error.message || '')
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

      // No table means no columns, and there is nothing to narrow down -- every
      // gated column on it is absent by definition. One probe answers it, and
      // skipping the per-column follow-up avoids firing a request per column
      // that can only produce the same error.
      if (isMissingTableError(error)) {
        for (const column of columns) absent.push(`${table}.${column}`)
        return
      }

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
