import { describe, it, expect } from 'vitest'
import {
  TYPES,
  STATUSES,
  monthKey,
  projectCounts,
  milestoneProgress,
  filterProjects,
  carryOverCandidates,
  carryOverPayload,
  dueMilestones,
} from '../src/lib/projects.js'

const P = (over = {}) => ({ id: over.id || 'p', month: '2026-09-01', name: 'x', type: 'coding', status: 'active', carried_from: null, ...over })

describe('vocabulary', () => {
  it('spells values the way the hand-made checks in 026 do', () => {
    expect(TYPES.map((t) => t.value)).toEqual(['coding', 'hands-on'])
    expect(STATUSES.map((s) => s.value)).toEqual(['active', 'complete', 'carried-over'])
  })
})

describe('monthKey', () => {
  it('reads YYYY-MM from a stored month or a date', () => {
    expect(monthKey('2026-09-01')).toBe('2026-09')
    expect(monthKey(new Date(2026, 1, 14))).toBe('2026-02')
  })
})

describe('projectCounts', () => {
  it('counts what the four tiles show', () => {
    const counts = projectCounts([
      P({ id: 'a' }),
      P({ id: 'b', type: 'hands-on', status: 'complete' }),
      P({ id: 'c', status: 'active', carried_from: '2026-08-01' }),
      null,
    ])
    expect(counts).toEqual({ total: 3, active: 2, coding: 2, handsOn: 1, complete: 1, carriedOver: 1 })
  })

  it('is all zeros for nothing', () => {
    expect(projectCounts([]).total).toBe(0)
    expect(projectCounts(undefined).total).toBe(0)
  })
})

describe('milestoneProgress', () => {
  it('reports done over total', () => {
    expect(milestoneProgress([{ completed: true }, { completed: false }, { completed: true }])).toEqual({ done: 2, total: 3, share: 2 / 3 })
  })

  it('has no share to report with no milestones', () => {
    expect(milestoneProgress([])).toEqual({ done: 0, total: 0, share: 0 })
  })
})

describe('filterProjects', () => {
  const rows = [
    P({ id: 'a' }),
    P({ id: 'b', status: 'complete' }),
    P({ id: 'c', carried_from: '2026-08-01' }),
    P({ id: 'd', status: 'carried-over' }),
  ]

  it('shows everything on All', () => {
    expect(filterProjects(rows, 'all').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('splits active and complete', () => {
    expect(filterProjects(rows, 'active').map((p) => p.id)).toEqual(['a', 'c'])
    expect(filterProjects(rows, 'complete').map((p) => p.id)).toEqual(['b'])
  })

  it('treats "carried" as a fact of history, not only a status', () => {
    expect(filterProjects(rows, 'carried').map((p) => p.id)).toEqual(['c', 'd'])
  })
})

describe('carryOverCandidates', () => {
  it('offers only unfinished projects from earlier months', () => {
    const rows = [
      P({ id: 'old-active', month: '2026-08-01' }),
      P({ id: 'old-done', month: '2026-08-01', status: 'complete' }),
      P({ id: 'this-month', month: '2026-09-01' }),
    ]
    expect(carryOverCandidates(rows, '2026-09-01').map((p) => p.id)).toEqual(['old-active'])
  })
})

describe('carryOverPayload', () => {
  it('moves the row and remembers its first month', () => {
    const payload = carryOverPayload(P({ month: '2026-08-01' }), '2026-09-01')
    expect(payload.month).toBe('2026-09-01')
    expect(payload.carried_from).toBe('2026-08-01')
    expect(payload.status).toBe('active')
  })

  it('keeps the original origin across a second carry', () => {
    const payload = carryOverPayload(P({ month: '2026-08-01', carried_from: '2026-07-01' }), '2026-09-01')
    expect(payload.carried_from).toBe('2026-07-01')
  })
})

describe('dueMilestones', () => {
  const projects = [P({ id: 'live' }), P({ id: 'done', status: 'complete' })]
  const milestones = [
    { id: 'm1', project_id: 'live', title: 'late', due_date: '2026-09-20', completed: false },
    { id: 'm2', project_id: 'live', title: 'today', due_date: '2026-09-22', completed: false },
    { id: 'm3', project_id: 'live', title: 'future', due_date: '2026-09-30', completed: false },
    { id: 'm4', project_id: 'live', title: 'finished', due_date: '2026-09-01', completed: true },
    { id: 'm5', project_id: 'done', title: 'on a finished project', due_date: '2026-09-01', completed: false },
    { id: 'm6', project_id: 'live', title: 'undated', due_date: null, completed: false },
  ]

  it('returns open milestones due by today on active projects, soonest first, flagging overdue', () => {
    const due = dueMilestones(projects, milestones, '2026-09-22')
    expect(due.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(due[0].overdue).toBe(true)
    expect(due[1].overdue).toBe(false)
    expect(due[0].project.id).toBe('live')
  })

  it('is empty with nothing to say', () => {
    expect(dueMilestones([], [], '2026-09-22')).toEqual([])
  })
})
