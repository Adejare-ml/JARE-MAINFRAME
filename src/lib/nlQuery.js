/**
 * A whitelisted, typed dispatch table for natural-language money questions.
 *
 * The other half of this project's citation-gating pattern, applied to a
 * question instead of a plan or a recap. A model asked "how much did I spend
 * on transport" could, in principle, be handed a database connection and
 * asked to write SQL for it -- and that is exactly the design this file
 * exists to refuse. SQL a model writes can select anything, filter on
 * anything, and be subtly wrong in a way nothing here would catch. A closed
 * set of named functions cannot: the model's only power is to pick one of
 * these by NAME and supply its declared arguments, and `runQuery` validates
 * both before anything runs. The actual arithmetic is the same pure functions
 * every other page already uses -- summarizeMonth, goalProgress, debtTotals
 * -- so an answer from here can never disagree with the number on screen.
 *
 * `runQuery` never throws. An unknown function name, a missing or
 * wrong-typed argument, or an error inside a query function all come back as
 * `{ok: false, reason}` -- the same "always a reason in words" discipline
 * planReview.js and recapReview.js both follow.
 */

import { summarizeMonth } from './summary.js'
import { goalProgress } from './planning.js'
import { debtTotals } from './debts.js'

/**
 * @typedef {{type: 'string'|'number', required?: boolean}} ParamSpec
 * @typedef {{description: string, params: Record<string, ParamSpec>, run: (args: object, context: object) => object}} QueryEntry
 */

/** @type {Record<string, QueryEntry>} */
const QUERIES = {
  spendThisMonth: {
    description: "This month's total spend so far, transfers excluded.",
    params: {},
    run: (args, ctx) => {
      const { spent } = summarizeMonth(ctx.monthTransactions, ctx.liquidWalletIds)
      return { spent }
    },
  },

  spendByCategory: {
    description: 'How much went to one category this month.',
    params: { category: { type: 'string', required: true } },
    run: (args, ctx) => {
      const { byCategory } = summarizeMonth(ctx.monthTransactions, ctx.liquidWalletIds)
      const wanted = args.category.toLowerCase()
      const row = (byCategory || []).find((c) => c.category.toLowerCase() === wanted)
      return { category: args.category, total: row ? row.total : 0 }
    },
  },

  goalProgressFor: {
    description: 'How far along one goal is, given its id.',
    params: { goalId: { type: 'string', required: true } },
    run: (args, ctx) => {
      const goal = (ctx.goals || []).find((g) => g.id === args.goalId)
      if (!goal) return { found: false }
      return { found: true, ...goalProgress(goal, ctx.goalTransactions || []) }
    },
  },

  walletBalance: {
    description: 'The current balance of one wallet, given its name.',
    params: { walletName: { type: 'string', required: true } },
    run: (args, ctx) => {
      const wanted = args.walletName.toLowerCase()
      const wallet = (ctx.wallets || []).find((w) => String(w.name || '').toLowerCase() === wanted)
      return wallet ? { found: true, balance: Number(wallet.balance) || 0 } : { found: false }
    },
  },

  debtsOutstanding: {
    description: 'Totals owed and owing across every open debt.',
    params: {},
    run: (args, ctx) => debtTotals(ctx.debts || []),
  },
}

/** Every function name a model may call. Exported so the prompt builder and tests stay in sync with this file rather than duplicating the list. */
export const QUERY_NAMES = Object.keys(QUERIES)

/** Argument problems for one call, in words. Empty when the call is well formed. */
function validateArgs(spec, rawArgs) {
  const problems = []
  const given = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}

  for (const [name, paramSpec] of Object.entries(spec)) {
    const value = given[name]
    if (value == null || value === '') {
      if (paramSpec.required) problems.push(`missing required argument "${name}"`)
      continue
    }
    if (paramSpec.type === 'string' && typeof value !== 'string') {
      problems.push(`"${name}" must be a string`)
    }
    if (paramSpec.type === 'number' && typeof value !== 'number') {
      problems.push(`"${name}" must be a number`)
    }
  }

  // An argument the function never declared is refused rather than ignored --
  // a model passing something unexpected has misunderstood what it is
  // calling, and silently dropping the extra field would hide that.
  for (const name of Object.keys(given)) {
    if (!(name in spec)) problems.push(`"${name}" is not a recognised argument`)
  }

  return problems
}

/**
 * Run one whitelisted query, or explain why not.
 *
 * Never throws and never runs anything not named in QUERIES -- a model
 * naming a function that does not exist, or supplying the wrong arguments,
 * gets a reason back instead of a stack trace or a query built from its own
 * text.
 *
 * @param {{function: string, args?: object}} call
 * @param {object} [context] - pre-fetched, already-scoped data the query
 *   functions read (monthTransactions, liquidWalletIds, goals,
 *   goalTransactions, wallets, debts) -- never fetched by this file itself,
 *   so it stays free of any database or network dependency.
 * @returns {{ok: true, result: object} | {ok: false, reason: string}}
 */
export function runQuery(call, context = {}) {
  const name = call && typeof call === 'object' && !Array.isArray(call) ? call.function : null

  if (typeof name !== 'string' || !name || !Object.prototype.hasOwnProperty.call(QUERIES, name)) {
    return { ok: false, reason: `"${name ?? '(nothing)'}" is not one of the questions this app can answer` }
  }

  const entry = QUERIES[name]
  const problems = validateArgs(entry.params, call.args)
  if (problems.length > 0) {
    return { ok: false, reason: problems.join('; ') }
  }

  try {
    return { ok: true, result: entry.run(call.args || {}, context || {}) }
  } catch (err) {
    // A query function reading past what the context actually holds (a
    // missing array, say) must read as "could not answer", not crash whatever
    // called runQuery.
    return { ok: false, reason: `could not answer: ${err?.message || 'unexpected error'}` }
  }
}

/** Every query's name, description and argument shape -- what a prompt tells a model it may ask for. */
export function describeQueries() {
  return QUERY_NAMES.map((name) => ({
    name,
    description: QUERIES[name].description,
    params: Object.entries(QUERIES[name].params).map(([paramName, spec]) => ({
      name: paramName,
      type: spec.type,
      required: Boolean(spec.required),
    })),
  }))
}
