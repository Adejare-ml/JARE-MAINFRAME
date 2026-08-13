/**
 * Turning goals into the tasks they imply, against the database.
 *
 * `planning.js` decides *what* a goal asks for; this decides *what to write*.
 * It is kept apart so planning stays pure and testable without a backend, and
 * it takes the client as an argument for the same reason `probeSchema(client)`
 * does -- `supabase.js` throws without its env vars, so a module that imports it
 * cannot be unit-tested at all.
 *
 * The chain is monthly -> weekly -> daily. A monthly goal produces this week's
 * target; that week's target produces today's task. Both passes are idempotent:
 * running this twice writes nothing the second time.
 *
 * What it deliberately does NOT do is set `completed`. A measured task is done
 * when the ledger says so, computed at render time by `goalProgress`. Writing
 * the flag would be worse than redundant -- `reconcileGenerated` reads
 * `completed` as "a person touched this row" and stops regenerating it, so a
 * generator that ticked its own output would freeze the figure at the moment
 * the target was first met, and voiding the transaction behind it would leave
 * the task ticked for good.
 */

import { hasColumn } from './schema.js'
import {
  toDateOnly,
  startOfMonth,
  startOfWeek,
  endOfWeek,
  excludeVoided,
  transactionSummaryColumns,
} from './queries.js'
import { goalProgress, decomposeMonthly, decomposeWeekly, reconcileGenerated } from './planning.js'

/** Rows whose date falls inside [from, to] inclusive. */
function within(transactions, from, to) {
  return (transactions || []).filter((t) => {
    const d = t.transaction_date
    return d && d >= from && d <= to
  })
}

/**
 * Derive and store the tasks the current goals imply.
 *
 * Never throws. A generator that cannot run must cost you the generated tasks
 * and nothing else -- Daily HQ already treats `debts` this way, soft-failing so
 * an un-run migration does not take the page down.
 *
 * @param {object} client - a supabase client
 * @param {{today?: string}} [options]
 * @returns {Promise<{written: number, unchanged: number, kept: number, skipped?: string, error?: string}>}
 */
export async function generateTasks(client, { today = toDateOnly(new Date()) } = {}) {
  const empty = { written: 0, unchanged: 0, kept: 0 }

  // Without 009 every one of these columns is absent, so each write would come
  // back PGRST204. Saying so and stopping beats a page full of failed inserts.
  if (!hasColumn('goals.metric')) {
    return { ...empty, skipped: 'migration 009_goal_cadence.sql has not been run' }
  }

  try {
    const anchor = new Date(`${today}T00:00:00`)
    const monthStart = startOfMonth(anchor)
    const weekStart = startOfWeek(anchor)
    const weekEnd = endOfWeek(anchor)

    const [goalsRes, txnRes] = await Promise.all([
      client.from('goals').select('*').gte('target_date', monthStart),
      excludeVoided(
        client
          .from('transactions')
          .select(transactionSummaryColumns())
          .gte('transaction_date', monthStart),
      ),
    ])

    if (goalsRes.error) throw goalsRes.error
    if (txnRes.error) throw txnRes.error

    const allGoals = goalsRes.data || []
    const transactions = txnRes.data || []

    const monthRows = transactions
    const weekRows = within(transactions, weekStart, weekEnd)

    let written = 0
    let unchanged = 0
    let kept = 0

    // ── Weekly pass: monthly goals produce this week's target ──
    const monthly = allGoals.filter((g) => g.period === 'monthly' && g.metric !== 'manual')
    const existingWeekly = allGoals.filter(
      (g) => g.period === 'weekly' && g.target_date === weekStart,
    )

    const weeklyCandidates = monthly
      .map((goal) => decomposeMonthly(goal, goalProgress(goal, monthRows), today))
      .filter(Boolean)

    const weeklyPlan = reconcileGenerated(weeklyCandidates, existingWeekly)
    unchanged += weeklyPlan.unchanged.length
    kept += weeklyPlan.kept.length

    let storedWeekly = existingWeekly
    if (weeklyPlan.write.length > 0) {
      const { data, error } = await client
        .from('goals')
        .upsert(weeklyPlan.write, { onConflict: 'period,target_date,slot' })
        .select()
      if (error) throw error
      written += weeklyPlan.write.length

      // The daily pass needs these rows' ids as parent_id, which is why the
      // upsert asks for them back rather than firing and forgetting.
      const returned = data || []
      const returnedIds = new Set(returned.map((r) => r.id))
      storedWeekly = existingWeekly.filter((g) => !returnedIds.has(g.id)).concat(returned)
    }

    // ── Daily pass: weekly goals produce today's task ──
    // Hand-made weekly goals count too: a goal you set yourself should still
    // tell you what it means today.
    const weekly = storedWeekly
      .concat(allGoals.filter((g) => g.period === 'weekly' && g.target_date !== weekStart))
      .filter((g) => g.metric !== 'manual' && g.target_date === weekStart)

    const existingDaily = allGoals.filter(
      (g) => g.period === 'daily' && g.target_date === today,
    )

    const dailyCandidates = weekly
      .map((goal) => decomposeWeekly(goal, goalProgress(goal, weekRows), today))
      .filter(Boolean)

    const dailyPlan = reconcileGenerated(dailyCandidates, existingDaily)
    unchanged += dailyPlan.unchanged.length
    kept += dailyPlan.kept.length

    if (dailyPlan.write.length > 0) {
      const { error } = await client
        .from('goals')
        .upsert(dailyPlan.write, { onConflict: 'period,target_date,slot' })
      if (error) throw error
      written += dailyPlan.write.length
    }

    return { written, unchanged, kept }
  } catch (err) {
    // Reported rather than thrown, and never surfaced as a toast: this runs
    // without the user asking, so an error here is a log line, not an
    // interruption about something they did not do.
    console.warn('Task generation skipped:', err?.message || err)
    return { ...empty, error: err?.message || String(err) }
  }
}
