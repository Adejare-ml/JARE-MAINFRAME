/**
 * Recurring-payment detection over already-synced transactions.
 *
 * Deterministic clustering, not inference: three or more transactions to or
 * from the same counterparty and wallet, close enough in amount and spaced at
 * a consistent interval, are reported as one recurring candidate with a next-
 * expected date and a confidence score. No LLM, no network -- an
 * "upcoming bills" preview is arithmetic on rows the app already has, the
 * same discipline planning.js applies to a goal's pace.
 *
 * Pure and importing nothing from supabase.js, so it is testable without a
 * database and safe to run in the browser on whatever window of transactions
 * a page has already fetched.
 */

/** How far an individual amount may drift from the cluster's median and still count. */
const AMOUNT_TOLERANCE = 0.05

/** Fewer than this and a pattern is a coincidence, not a habit. */
const MIN_OCCURRENCES = 3

/**
 * Candidate intervals, closest-labelled-first. `slack` is how many days a
 * gap may miss the target by -- bank posting dates jitter around a due date
 * by a day or two, and a "monthly" bill does not land on the same date every
 * month (28-31 day months).
 */
const INTERVAL_BUCKETS = [
  { label: 'weekly', days: 7, slack: 2 },
  { label: 'biweekly', days: 14, slack: 3 },
  { label: 'monthly', days: 30, slack: 5 },
]

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Whole days between two YYYY-MM-DD strings, B minus A. */
function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00`)
  const db = new Date(`${b}T00:00:00`)
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return 0
  return Math.round((db - da) / 86400000)
}

/** `date` plus `days`, as a YYYY-MM-DD string. */
function addDays(date, days) {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Group transactions by who they were with and which wallet they moved
 * through -- the same payee on two different wallets is two different habits
 * (rent paid from GTBank vs. an accidental double debit on Opay), not one.
 */
function groupingKey(t) {
  const who = (t.recipient || t.description || '').trim().toLowerCase()
  if (!who) return null
  return `${who}::${t.wallet_id || ''}::${t.type}`
}

/**
 * Find recurring patterns in a window of transactions.
 *
 * @param {Array<object>} transactions - rows with at least
 *   {type, amount, transaction_date, recipient?, description?, wallet_id?, category?, voided?}
 * @param {string} [today] - YYYY-MM-DD, for `nextExpected` and `overdue`
 * @returns {Array<{
 *   key: string, label: string, category: string|null, type: string,
 *   amount: number, interval: 'weekly'|'biweekly'|'monthly', occurrences: number,
 *   lastDate: string, nextExpected: string, overdue: boolean, confidence: number,
 * }>} sorted by nextExpected, soonest first
 */
export function detectRecurring(transactions, today = new Date().toISOString().slice(0, 10)) {
  const groups = new Map()

  for (const t of transactions || []) {
    if (!t || t.voided || !t.transaction_date) continue
    const amount = Number(t.amount)
    if (!(amount > 0)) continue
    const key = groupingKey(t)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }

  const candidates = []

  for (const [key, rows] of groups) {
    if (rows.length < MIN_OCCURRENCES) continue

    const sorted = [...rows].sort((a, b) => (a.transaction_date < b.transaction_date ? -1 : 1))
    const amounts = sorted.map((r) => Number(r.amount))
    const amountMedian = median(amounts)
    if (!(amountMedian > 0)) continue

    const amountDeviations = amounts.map((a) => Math.abs(a - amountMedian) / amountMedian)
    if (amountDeviations.some((d) => d > AMOUNT_TOLERANCE)) continue

    const gaps = []
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(daysBetween(sorted[i - 1].transaction_date, sorted[i].transaction_date))
    }
    // A same-day repeat (a gap of 0, e.g. a correction) is not a recurring
    // interval -- it would collapse the median toward zero and match nothing.
    if (gaps.some((g) => g <= 0)) continue

    const gapMedian = median(gaps)
    const bucket = INTERVAL_BUCKETS.find((b) => Math.abs(gapMedian - b.days) <= b.slack)
    if (!bucket) continue

    const gapDeviations = gaps.map((g) => Math.abs(g - gapMedian))
    if (gapDeviations.some((d) => d > bucket.slack)) continue

    const last = sorted[sorted.length - 1]
    const nextExpected = addDays(last.transaction_date, Math.round(gapMedian))

    // 1 minus how far amounts and gaps drifted, plus a small bonus for a
    // longer track record -- more repeats is more evidence, capped so a
    // years-long habit cannot mask genuinely irregular recent behaviour.
    const amountSpread = Math.max(...amountDeviations)
    const gapSpread = Math.max(...gapDeviations) / bucket.days
    const trackRecordBonus = Math.min(0.15, (rows.length - MIN_OCCURRENCES) * 0.05)
    const confidence = Math.max(0, Math.min(1, 1 - amountSpread - gapSpread + trackRecordBonus))

    candidates.push({
      key,
      label: last.recipient || last.description || 'Unknown',
      category: last.category || null,
      type: last.type,
      amount: amountMedian,
      interval: bucket.label,
      occurrences: rows.length,
      lastDate: last.transaction_date,
      nextExpected,
      overdue: nextExpected < today,
      confidence: Math.round(confidence * 100) / 100,
    })
  }

  return candidates.sort((a, b) => (a.nextExpected < b.nextExpected ? -1 : 1))
}
