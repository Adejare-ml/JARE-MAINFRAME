/**
 * Project math, kept pure so it can be tested without a browser or a
 * database -- the same reason debts.js exists next to Debts.jsx.
 *
 * A project belongs to a month. What did not finish in one month is carried
 * into the next, and the row records where it came from, so "Carried Over"
 * is something you can see at a glance rather than something you remember.
 */

import { startOfMonth, toDateOnly } from './queries.js'

export const TYPES = [
  { value: 'coding', label: 'Coding', icon: '💻' },
  { value: 'hands-on', label: 'Hands-on', icon: '🔨' },
]

export const STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'complete', label: 'Complete' },
  { value: 'carried-over', label: 'Carried over' },
]

/** `YYYY-MM` from a project's stored month, or from today. */
export function monthKey(date = new Date()) {
  return startOfMonth(typeof date === 'string' ? new Date(date + 'T00:00:00') : date).slice(0, 7)
}

/**
 * What the four counters on the page say.
 *
 * @param {Array<{type?: string, status?: string}>} projects
 * @returns {{total: number, active: number, coding: number, handsOn: number, complete: number, carriedOver: number}}
 */
export function projectCounts(projects = []) {
  const counts = { total: 0, active: 0, coding: 0, handsOn: 0, complete: 0, carriedOver: 0 }
  for (const p of projects || []) {
    if (!p) continue
    counts.total += 1
    if (p.status === 'active') counts.active += 1
    if (p.status === 'complete') counts.complete += 1
    if (p.status === 'carried-over' || p.carried_from) counts.carriedOver += 1
    if (p.type === 'coding') counts.coding += 1
    if (p.type === 'hands-on') counts.handsOn += 1
  }
  return counts
}

/**
 * How far along a project's milestones are.
 *
 * @param {Array<{completed?: boolean}>} milestones
 * @returns {{done: number, total: number, share: number}}
 */
export function milestoneProgress(milestones = []) {
  const rows = (milestones || []).filter(Boolean)
  const done = rows.filter((m) => m.completed).length
  return { done, total: rows.length, share: rows.length === 0 ? 0 : done / rows.length }
}

/**
 * Which projects a tab shows. `carried` is the ones that arrived from an
 * earlier month, whatever their status now.
 */
export function filterProjects(projects = [], tab = 'all') {
  return (projects || []).filter((p) => {
    if (!p) return false
    if (tab === 'all') return true
    if (tab === 'active') return p.status === 'active'
    if (tab === 'complete') return p.status === 'complete'
    if (tab === 'carried') return Boolean(p.carried_from) || p.status === 'carried-over'
    return true
  })
}

/**
 * Projects from before `month` that never finished -- what a new month
 * offers to bring along.
 *
 * @param {Array<{month: string, status: string}>} projects
 * @param {string} [month] - YYYY-MM-DD first of the month
 */
export function carryOverCandidates(projects = [], month = startOfMonth()) {
  return (projects || []).filter((p) => p && p.status === 'active' && p.month < month)
}

/**
 * The write that carries a project forward: same row, moved to `month`,
 * remembering where it was. Status stays active -- carried-over is a fact
 * about its history (`carried_from`), not a state you have to leave.
 */
export function carryOverPayload(project, month = startOfMonth()) {
  return {
    month,
    carried_from: project.carried_from || project.month,
    status: 'active',
    updated_at: new Date().toISOString(),
  }
}

/**
 * Milestones due on or before `today` that are still open, across every
 * active project -- the hook a reminder digest or Daily HQ can pull on.
 *
 * @param {Array<{id: string, name: string, status: string}>} projects
 * @param {Array<{project_id: string, due_date?: string|null, completed?: boolean, title: string}>} milestones
 * @param {string} [today] - YYYY-MM-DD
 */
export function dueMilestones(projects = [], milestones = [], today = toDateOnly(new Date())) {
  const active = new Map((projects || []).filter((p) => p && p.status === 'active').map((p) => [p.id, p]))
  return (milestones || [])
    .filter((m) => m && !m.completed && m.due_date && m.due_date <= today && active.has(m.project_id))
    .map((m) => ({ ...m, project: active.get(m.project_id), overdue: m.due_date < today }))
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0))
}
