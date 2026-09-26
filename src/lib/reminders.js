/**
 * The morning digest: what needs you today, in one short message.
 *
 * The app already computes every item here -- debts due, bills expected,
 * urgent repairs, milestones past their date, rows waiting for review --
 * and shows them only when it is opened. This turns the same answers into
 * something that can be sent (Stages 20-21: web push) and read in one
 * glance on a lock screen. Nothing is recomputed differently: each list
 * comes from the module that owns it, so the digest can never disagree
 * with the page it points at.
 *
 * A quiet day returns null, not an empty digest. Sending "nothing today"
 * every morning trains the reader to swipe it away, and the one that
 * matters goes with it.
 */
import { upcomingDebts, outstanding, cycleStatus, daysUntil, isRotating } from './debts.js'
import { detectRecurring } from './recurring.js'
import { urgentRepairs } from './repairs.js'
import { dueMilestones } from './projects.js'
import { STATUS } from './health.js'

/** Debts due or paying out within this many days make the digest. */
export const DEBT_WINDOW_DAYS = 3
/** Recurring bills expected within this many days make the digest. */
export const BILL_WINDOW_DAYS = 2
/** Push payloads are small; the body is cut here, the title earlier. */
export const BODY_MAX = 180
export const TITLE_MAX = 80

/** Where a tap on an item of each kind should land. */
export const KIND_URLS = {
  debt: '/debts',
  bill: '/transactions',
  repair: '/repairs',
  milestone: '/projects',
  review: '/transactions',
  system: '/settings',
}

const money = (n) => `₦${Math.round(Number(n) || 0).toLocaleString('en-US')}`

/** "today", "in 2d", "3d overdue". */
function when(days, { past = 'overdue', future = 'in' } = {}) {
  if (days == null) return ''
  if (days < 0) return `${-days}d ${past}`
  if (days === 0) return 'today'
  return `${future} ${days}d`
}

function debtItems(debts, now) {
  return upcomingDebts(debts, DEBT_WINDOW_DAYS, now).map(({ debt, days, kind }) => {
    const rotating = isRotating(debt.kind)
    let text
    if (kind === 'payout') {
      const pot = cycleStatus(debt)?.expectedPot
      text = `${debt.counterparty}: ${pot ? `pot of ${money(pot)} ` : ''}pays out ${when(days, { past: 'ago' })}`
    } else if (rotating) {
      text = `${debt.counterparty}: ${debt.contribution ? `${money(debt.contribution)} ` : ''}contribution due ${when(days)}`
    } else {
      const left = outstanding(debt)
      text = `${debt.counterparty}: ${left > 0 ? `${money(left)} ` : ''}due ${when(days)}`
    }
    return { kind: 'debt', text, url: KIND_URLS.debt, days }
  })
}

function billItems(transactions, today, now) {
  return detectRecurring(transactions || [], today)
    .map((bill) => ({ bill, days: daysUntil(bill.nextExpected, now) }))
    .filter(({ bill, days }) => bill.overdue || (days != null && days <= BILL_WINDOW_DAYS))
    .map(({ bill, days }) => ({
      kind: 'bill',
      text: `${bill.label}: ${money(bill.amount)} expected ${when(days, { past: 'overdue' })}`,
      url: KIND_URLS.bill,
      days,
    }))
}

function repairItems(repairs, today, now) {
  return urgentRepairs(repairs || [], today).map((repair) => {
    const days = daysUntil(repair.due_date, now)
    const due = repair.due_date ? `, due ${when(days)}` : ''
    return {
      kind: 'repair',
      text: `${repair.item}: ${repair.priority}${due}`,
      url: KIND_URLS.repair,
      days: days == null ? 0 : days,
    }
  })
}

function milestoneItems(projects, milestones, today, now) {
  return dueMilestones(projects || [], milestones || [], today).map((m) => {
    const days = daysUntil(m.due_date, now)
    return {
      kind: 'milestone',
      text: `${m.title} (${m.project?.name || 'project'}) ${when(days)}`,
      url: KIND_URLS.milestone,
      days,
    }
  })
}

/**
 * Jobs that have stopped or are failing, from health.js's summarizeRuns.
 * First in the digest, because every other line depends on them: a dead
 * bank-alert audit means the review count, the bills and the balances are
 * all yesterday's, and nothing else in the pipeline says so.
 */
function systemItems(jobs, today) {
  return (jobs || [])
    .filter((job) => job && (job.status === STATUS.FAILING || job.status === STATUS.STALE))
    .map((job) => {
      const last = job.lastRun?.finished_at ? String(job.lastRun.finished_at).slice(0, 10) : null
      const days = last ? Math.round((new Date(`${today}T00:00:00`) - new Date(`${last}T00:00:00`)) / 86400000) : null
      const since = days == null ? '' : days <= 0 ? ' today' : days === 1 ? ' yesterday' : ` ${days}d ago`
      const text = job.status === STATUS.FAILING
        ? `${job.label} is failing (last run${since})`
        : `${job.label} has not run (last${since})`
      return { kind: 'system', text, url: KIND_URLS.system, days: days == null ? 0 : -days }
    })
}

const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

/** Web push payloads are capped around 4 KB by the push services. */
export const PAYLOAD_MAX_BYTES = 3500

/**
 * What goes over the wire: the three fields public/sw.js reads, nothing
 * else. The item list is for logs and the app, not the lock screen.
 *
 * @param {{title: string, body: string, url: string}} digest
 * @returns {string} JSON
 */
export function toPushPayload(digest) {
  const payload = JSON.stringify({
    title: cut(String(digest?.title || ''), TITLE_MAX),
    body: cut(String(digest?.body || ''), BODY_MAX),
    url: typeof digest?.url === 'string' && digest.url.startsWith('/') ? digest.url : '/',
  })
  // TextEncoder rather than Buffer: this module is shared with the browser
  // build, which has no Buffer.
  const bytes = new TextEncoder().encode(payload).length
  if (bytes > PAYLOAD_MAX_BYTES) {
    throw new Error(`push payload is ${bytes} bytes; the cap is ${PAYLOAD_MAX_BYTES}`)
  }
  return payload
}

/**
 * What to do with a subscription after a failed send.
 *
 * 404 and 410 are the push service saying the subscription no longer
 * exists -- the browser unsubscribed, the app was uninstalled, the keys
 * rotated -- so the row is deleted. Anything else (a 5xx, a 429, a network
 * error with no status) is a bad morning, not a dead device, and the row
 * is stamped instead so the next run tries again.
 *
 * @param {number|undefined|null} statusCode
 * @returns {'gone'|'retry'}
 */
export function classifySendError(statusCode) {
  return statusCode === 404 || statusCode === 410 ? 'gone' : 'retry'
}

/**
 * Build the digest, or null when there is nothing worth saying.
 *
 * @param {object} input
 * @param {object[]} [input.debts] - debts rows, settled ones included (they are skipped)
 * @param {object[]} [input.transactions] - recent, non-voided rows with recipient/description
 * @param {number} [input.unreviewedCount]
 * @param {object[]} [input.repairs]
 * @param {object[]} [input.projects]
 * @param {object[]} [input.milestones]
 * @param {object[]} [input.jobs] - summarizeRuns() output; failing or stale jobs lead the digest
 * @param {string} [input.today] - YYYY-MM-DD
 * @returns {{title: string, body: string, items: object[], url: string} | null}
 */
export function buildReminderDigest({
  debts = [],
  transactions = [],
  unreviewedCount = 0,
  repairs = [],
  projects = [],
  milestones = [],
  jobs = [],
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const now = new Date(`${today}T00:00:00`)
  const items = [
    ...systemItems(jobs, today),
    ...debtItems(debts, now),
    ...billItems(transactions, today, now),
    ...repairItems(repairs, today, now),
    ...milestoneItems(projects, milestones, today, now),
  ]
  // The review queue is a count, not a deadline, so it goes last: a debt
  // due today outranks twelve rows the parser was unsure about.
  const reviews = Number(unreviewedCount) || 0
  if (reviews > 0) {
    items.push({
      kind: 'review',
      text: `${reviews} transaction${reviews === 1 ? '' : 's'} to review`,
      url: KIND_URLS.review,
      days: null,
    })
  }

  if (items.length === 0) return null

  const title = items.length === 1 ? cut(items[0].text, TITLE_MAX) : `${items.length} things need you today`
  const body = cut(items.map((i) => i.text).join(' · '), BODY_MAX)
  // One kind of thing: land on its page. A mix: Daily HQ, which shows all of it.
  const kinds = new Set(items.map((i) => i.kind))
  const url = kinds.size === 1 ? KIND_URLS[items[0].kind] : '/'

  return { title, body, items, url }
}
