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

const cut = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`)

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
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const now = new Date(`${today}T00:00:00`)
  const items = [
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
