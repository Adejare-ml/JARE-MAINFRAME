/**
 * DEV-ONLY fixture session, for screenshots and the design review.
 *
 * Never in a production build: main.jsx imports this behind
 * `import.meta.env.DEV`, which Vite replaces with `false` in `vite build`,
 * so the import and this whole module are dropped (scripts/shots.mjs and
 * docs/design-system.md describe how to check). It needs no backend and no
 * credentials.
 *
 * Turn it on with `?fixture` on any dev URL (it sticks for the tab via
 * sessionStorage; `?fixture=off` clears it). It swaps the shared Supabase
 * client's methods for an in-memory one holding plausible data for one
 * person, and a fake signed-in session, so every page renders populated.
 *
 * Rail scenarios: `?fixture=ok|attention|failing|stale|never|offline|nomigration`
 * pick what sync_runs says (default ok). `offline` makes the sync_runs read fail.
 */

const KEY = 'jare_fixture'

export function fixtureScenario() {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.has('fixture')) {
      const value = params.get('fixture') || 'ok'
      if (value === 'off') {
        sessionStorage.removeItem(KEY)
        return null
      }
      sessionStorage.setItem(KEY, value)
      return value
    }
    return sessionStorage.getItem(KEY)
  } catch {
    return null
  }
}

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const dayOffset = (n) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d
}
const isoAt = (offsetDays, h, m = 0) => {
  const d = dayOffset(offsetDays)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function mondayOf(d) {
  const x = new Date(d)
  const day = (x.getDay() + 6) % 7
  x.setDate(x.getDate() - day)
  return ymd(x)
}

function syncRuns(scenario) {
  const ok = (job, offsetDays, h, m, summary = null) => ({ job, finished_at: isoAt(offsetDays, h, m), ok: true, summary })
  const base = [
    ok('claude-audit', 0, 9, 14, '9 mails found (6 debit, 3 credit); 9 recorded, 0 already there'),
    ok('verify-repo', 0, 2, 5),
    ok('snapshot-net-worth', 0, 11, 0),
    ok('reconcile', 0, 11, 30, '5 wallet(s) checked, ledger and bank alerts agree'),
    ok('weekly-recap', -3, 7, 0),
    ok('plan-month', -20, 6, 0),
    ok('remind', 0, 9, 20),
    ok('backup', -4, 3, 0),
  ]
  if (scenario === 'never') return []
  if (scenario === 'stale') return base.map((r) => (r.job === 'claude-audit' ? { ...r, finished_at: isoAt(-2, 9, 10) } : r))
  if (scenario === 'failing') return [{ job: 'claude-audit', finished_at: isoAt(0, 9, 14), ok: false, summary: 'Gmail read failed' }, ...base.filter((r) => r.job !== 'claude-audit')]
  if (scenario === 'attention')
    return base.map((r) => (r.job === 'backup' ? { ...r, ok: false, summary: 'not configured: no backup repository yet' } : r))
  return base
}

function buildTables(scenario) {
  const today = ymd(new Date())
  const wallets = [
    { id: uuid(1), name: 'GTBank', type: 'bank', balance: 182450.75, is_active: true, account_last4: '4821', alert_sender: 'gens@gtbank.com', last_alert_at: isoAt(0, 9, 41) },
    { id: uuid(2), name: 'OPay', type: 'mobile', balance: 23910, is_active: true, account_last4: '0912', alert_sender: 'no-reply@opay-nigeria.com', last_alert_at: isoAt(-1, 18, 2) },
    { id: uuid(3), name: 'Cash', type: 'cash', balance: 6500, is_active: true },
    { id: uuid(4), name: 'PiggyVest', type: 'savings', balance: 410000, is_active: true },
    { id: uuid(5), name: 'Bamboo', type: 'investment', balance: 1250300.4, is_active: true },
  ]
  let n = 100
  const tx = (offset, type, amount, category, description, walletIdx, time, source = 'gtbank', extra = {}) => ({
    id: uuid(n++),
    type,
    amount,
    currency: 'NGN',
    source,
    category,
    description,
    recipient: null,
    note: null,
    explanation: null,
    want_or_need: null,
    wallet_id: wallets[walletIdx].id,
    transaction_date: ymd(dayOffset(offset)),
    transaction_time: time,
    transaction_id: null,
    available_balance: null,
    confidence: 0.95,
    reviewed: true,
    debt_id: null,
    voided: false,
    created_at: isoAt(offset, Number(time.slice(0, 2)), Number(time.slice(3, 5))),
    ...extra,
  })
  const transactions = [
    tx(0, 'debit', 2500, 'Transport', 'Bolt ride to Wuse', 1, '09:41:00', 'opay'),
    tx(0, 'debit', 4200, 'Feeding / Groceries', 'Shoprite Jabi', 0, '08:15:00'),
    tx(0, 'credit', 35000, 'Transfer In', 'From Tunde, refund for tickets', 0, '07:02:00'),
    tx(-1, 'debit', 15000, 'Airtime & Data', 'MTN data bundle 25GB', 0, '18:20:00'),
    tx(-1, 'debit', 1800, 'Dining Out', 'Suya, Area 11', 2, '20:05:00', 'manual'),
    tx(-1, 'debit', 6800, 'Electricity', 'AEDC prepaid token', 0, '10:30:00'),
    tx(-2, 'debit', 52000, 'Rent', 'Service charge, Q4', 0, '12:00:00'),
    tx(-3, 'credit', 420000, 'Salary', 'November salary', 0, '09:00:00', 'gtbank', { category: 'Transfer In' }),
    tx(-4, 'debit', 9500, 'Pharmacy', 'MedPlus', 1, '16:40:00', 'opay'),
    tx(-5, 'debit', 3200, 'Transport', 'Fuel, Total Garki', 2, '07:50:00', 'manual'),
    tx(-6, 'debit', 12000, 'Subscriptions', 'Netflix and Spotify', 0, '06:00:00'),
    tx(-8, 'debit', 7400, 'Feeding / Groceries', 'Market, Wuse', 2, '11:15:00', 'manual'),
    tx(-9, 'debit', 2500, 'Transport', 'Bolt ride home', 1, '21:10:00', 'opay'),
    tx(-0, 'debit', 1200, 'Uncategorized', 'POS 0042 ABUJA', 0, '09:12:00', 'gtbank', { reviewed: false, confidence: 0.4 }),
  ]
  // Recurring bill pattern for UpcomingBills: DSTV monthly.
  for (const back of [27, 57, 87]) transactions.push(tx(-back, 'debit', 15700, 'Subscriptions', 'DSTV Compact', 0, '08:00:00'))

  const week = mondayOf(new Date())
  const goals = [
    { id: uuid(300), title: 'Send the Q4 invoice to Halden', slot: 0, period: 'daily', target_date: today, completed: true, plan_status: 'active' },
    { id: uuid(301), title: 'Review the reconciliation drift on OPay', slot: 1, period: 'daily', target_date: today, completed: false, plan_status: 'active' },
    { id: uuid(302), title: 'Spend under ₦10,000 today', slot: 10, period: 'daily', target_date: today, completed: false, generated: true, metric: 'spend_under', target_amount: 10000, plan_status: 'active' },
    { id: uuid(303), title: 'Gym, 45 minutes', slot: 2, period: 'daily', target_date: today, completed: false, plan_status: 'active' },
    { id: uuid(310), title: 'Save ₦20,000 this week', slot: 0, period: 'weekly', target_date: week, completed: false, metric: 'save_at_least', target_amount: 20000, plan_status: 'active' },
  ]
  for (let back = 1; back <= 40; back++) {
    const date = ymd(dayOffset(-back))
    if (back % 6 === 0) continue
    goals.push({ id: uuid(400 + back * 2), title: 'Plan item', slot: 0, period: 'daily', target_date: date, completed: back % 4 !== 0, plan_status: 'active' })
    goals.push({ id: uuid(401 + back * 2), title: 'Second item', slot: 1, period: 'daily', target_date: date, completed: back % 3 !== 0, plan_status: 'active' })
  }

  const debts = [
    { id: uuid(500), counterparty: 'Ada (Ajo circle)', kind: 'ajo', direction: 'owe', amount: 50000, due_date: ymd(dayOffset(2)), settled: false, created_at: isoAt(-60, 9) },
  ]

  return {
    wallets,
    transactions,
    goals,
    debts,
    user_settings: [
      { key: 'monthly_budget_target', value: '250000' },
      { key: 'low_balance_threshold', value: '5000' },
      { key: 'planner_tone', value: 'encouraging' },
    ],
    day_briefs: [
      {
        brief_date: today,
        source: 'calendar',
        free_minutes: 285,
        busy_minutes: 195,
        events: [
          { id: 'e1', title: 'Standup with the product team', start: isoAt(0, 10, 0), allDay: false },
          { id: 'e2', title: 'Client review, Halden', start: isoAt(0, 14, 30), allDay: false },
        ],
      },
    ],
    sync_runs: syncRuns(scenario),
    push_subscriptions: [{ id: uuid(600), endpoint: 'https://push.example/1' }],
    discovered_accounts: [],
    categories: [],
    category_budgets: [],
    category_rules: [],
    diet_settings: [{ id: uuid(700), kcal_target: 2400, protein_target_g: 140 }],
    foods: [],
    recipes: [],
    recipe_ingredients: [],
    saved_meals: [],
    meal_logs: [
      { id: uuid(710), eaten_on: today, eaten_at: isoAt(0, 8, 0), meal_slot: 'breakfast', source: 'manual', status: 'final', kcal: 520, protein_g: 28, carbs_g: 60, fat_g: 16, meal_items: [] },
      { id: uuid(711), eaten_on: today, eaten_at: isoAt(0, 13, 10), meal_slot: 'lunch', source: 'saved', status: 'final', kcal: 780, protein_g: 46, carbs_g: 82, fat_g: 24, meal_items: [] },
    ],
    net_worth_snapshots: [],
    projects: [],
    repairs: [],
    recaps: [],
    week_recaps: [],
    meals: [],
    integrations: [],
  }
}

// ── A tiny PostgREST-shaped query builder over arrays ──

function matches(row, filters) {
  return filters.every(([op, col, val]) => {
    const v = row[col]
    switch (op) {
      case 'eq': return v === val || String(v) === String(val)
      case 'neq': return v !== val
      case 'in': return val.includes(v)
      case 'gte': return v != null && v >= val
      case 'gt': return v != null && v > val
      case 'lte': return v != null && v <= val
      case 'lt': return v != null && v < val
      case 'is': return val === null ? v == null : v === val
      case 'notis': return val === null ? v != null : v !== val
      case 'ilike': return String(v || '').toLowerCase().includes(String(val).replace(/%/g, '').toLowerCase())
      default: return true
    }
  })
}

function builder(tables, table, opts = {}) {
  const state = { filters: [], order: [], limit: null, single: null, head: false, count: false, write: false }
  const api = {
    select(_cols, o = {}) {
      if (o.head) state.head = true
      if (o.count) state.count = true
      return api
    },
    insert() { state.write = true; return api },
    update() { state.write = true; return api },
    upsert() { state.write = true; return api },
    delete() { state.write = true; return api },
    eq(c, v) { state.filters.push(['eq', c, v]); return api },
    neq(c, v) { state.filters.push(['neq', c, v]); return api },
    in(c, v) { state.filters.push(['in', c, v]); return api },
    gte(c, v) { state.filters.push(['gte', c, v]); return api },
    gt(c, v) { state.filters.push(['gt', c, v]); return api },
    lte(c, v) { state.filters.push(['lte', c, v]); return api },
    lt(c, v) { state.filters.push(['lt', c, v]); return api },
    is(c, v) { state.filters.push(['is', c, v]); return api },
    not(c, op, v) { if (op === 'is') state.filters.push(['notis', c, v]); return api },
    ilike(c, v) { state.filters.push(['ilike', c, v]); return api },
    or() { return api },
    filter() { return api },
    match() { return api },
    contains() { return api },
    textSearch() { return api },
    range() { return api },
    order(c, o = {}) { state.order.push([c, o.ascending !== false]); return api },
    limit(n) { state.limit = n; return api },
    maybeSingle() { state.single = 'maybe'; return api },
    single() { state.single = 'one'; return api },
    then(resolve, reject) {
      return Promise.resolve(run()).then(resolve, reject)
    },
  }
  function run() {
    if (opts.error) return { data: null, error: opts.error, count: null }
    if (state.write) return { data: null, error: null }
    let rows = (tables[table] || []).filter((r) => matches(r, state.filters))
    for (const [col, asc] of [...state.order].reverse()) {
      rows = [...rows].sort((a, b) => (a[col] === b[col] ? 0 : (a[col] > b[col] ? 1 : -1) * (asc ? 1 : -1)))
    }
    if (state.limit != null) rows = rows.slice(0, state.limit)
    const count = state.count ? rows.length : null
    if (state.head) return { data: null, error: null, count }
    if (state.single) return { data: rows[0] || null, error: null, count }
    return { data: rows, error: null, count }
  }
  return api
}

export async function maybeInstallFixture() {
  const scenario = fixtureScenario()
  if (!scenario) return false
  const { supabase } = await import('../lib/supabase')
  const tables = buildTables(scenario)
  // offline: the sync_runs read fails. nomigration: it fails as a missing
  // column, so the schema probe marks sync_runs.job absent (wordmark only).
  const syncError =
    scenario === 'offline'
      ? { message: 'fixture: offline' }
      : scenario === 'nomigration'
        ? { code: '42703', message: 'column sync_runs.job does not exist' }
        : null

  const session = {
    access_token: 'fixture',
    user: { id: uuid(9), email: 'daniel@example.com', user_metadata: { name: 'Daniel' } },
  }

  supabase.from = (table) => builder(tables, table, table === 'sync_runs' && syncError ? { error: syncError } : {})
  supabase.rpc = async () => ({ data: null, error: null })
  supabase.channel = () => {
    const ch = { on: () => ch, subscribe: () => ch, unsubscribe: () => {} }
    return ch
  }
  supabase.removeChannel = () => {}
  supabase.functions.invoke = async () => ({ data: { ok: true, providers: { ollama: true } }, error: null })
  supabase.auth.getSession = async () => ({ data: { session }, error: null })
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } })
  supabase.auth.signOut = async () => ({ error: null })
  if (scenario === 'offline') {
    try {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
    } catch {
      // Some browsers refuse; the failed sync_runs read reports offline anyway.
    }
  }
  console.info(`[fixture] DEV fixture session on (scenario: ${scenario}). ?fixture=off to leave.`)
  return true
}
