/**
 * Repair-queue math, pure for the same reason debts.js and projects.js are.
 *
 * A repair is something broken or due for maintenance, with a priority, a
 * status and a guess at what it will cost. The cost that matters on the page
 * is what is still ahead -- an estimate for a repair already done is history.
 */

export const PRIORITIES = [
  { value: 'urgent', label: 'Urgent', icon: '🔥' },
  { value: 'soon', label: 'Soon', icon: '📅' },
  { value: 'someday', label: 'Someday', icon: '🌱' },
]

export const STATUSES = [
  { value: 'pending', label: 'Pending' },
  { value: 'in-progress', label: 'In progress' },
  { value: 'done', label: 'Done' },
]

export const CLASSIFICATIONS = [
  { value: 'need', label: 'Need' },
  { value: 'want', label: 'Want' },
]

const PRIORITY_RANK = { urgent: 0, soon: 1, someday: 2 }
const STATUS_RANK = { 'in-progress': 0, pending: 1, done: 2 }

/** The next status a tap moves a repair to; Done wraps back to Pending. */
export function nextStatus(status) {
  if (status === 'pending') return 'in-progress'
  if (status === 'in-progress') return 'done'
  return 'pending'
}

/**
 * @param {Array<{status?: string}>} repairs
 * @returns {{pending: number, inProgress: number, done: number, total: number}}
 */
export function repairCounts(repairs = []) {
  const counts = { pending: 0, inProgress: 0, done: 0, total: 0 }
  for (const r of repairs || []) {
    if (!r) continue
    counts.total += 1
    if (r.status === 'pending') counts.pending += 1
    else if (r.status === 'in-progress') counts.inProgress += 1
    else if (r.status === 'done') counts.done += 1
  }
  return counts
}

/**
 * @param {Array<{status?: string, estimated_cost?: number|string|null}>} repairs
 * @returns {{openEstimate: number, allEstimate: number}} money still ahead, and everything ever estimated
 */
export function costTotals(repairs = []) {
  let openEstimate = 0
  let allEstimate = 0
  for (const r of repairs || []) {
    if (!r) continue
    const cost = Number(r.estimated_cost) || 0
    if (cost <= 0) continue
    allEstimate += cost
    if (r.status !== 'done') openEstimate += cost
  }
  return { openEstimate, allEstimate }
}

/** What a priority chip shows: everything, or one priority. */
export function filterRepairs(repairs = [], priority = 'all') {
  return (repairs || []).filter((r) => r && (priority === 'all' || r.priority === priority))
}

/**
 * The order the queue reads in: in-progress first (already started), then
 * pending, done last; within a status by priority, then the nearest due
 * date, undated after dated.
 */
export function sortRepairs(repairs = []) {
  return (repairs || [])
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const s = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
      if (s !== 0) return s
      const p = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
      if (p !== 0) return p
      if (a.due_date && b.due_date) return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0
      if (a.due_date) return -1
      if (b.due_date) return 1
      return 0
    })
}

/** Open repairs that are urgent, or due on or before `today` -- what deserves a nudge. */
export function urgentRepairs(repairs = [], today) {
  return sortRepairs(repairs).filter(
    (r) => r.status !== 'done' && (r.priority === 'urgent' || (today && r.due_date && r.due_date <= today)),
  )
}
