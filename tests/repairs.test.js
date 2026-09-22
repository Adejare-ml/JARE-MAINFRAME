import { describe, it, expect } from 'vitest'
import {
  PRIORITIES,
  STATUSES,
  nextStatus,
  repairCounts,
  costTotals,
  filterRepairs,
  sortRepairs,
  urgentRepairs,
} from '../src/lib/repairs.js'

const R = (over = {}) => ({ id: over.id || 'r', item: 'x', priority: 'soon', status: 'pending', estimated_cost: null, due_date: null, ...over })

describe('vocabulary', () => {
  it('spells values the way the hand-made checks in 027 do', () => {
    expect(PRIORITIES.map((p) => p.value)).toEqual(['urgent', 'soon', 'someday'])
    expect(STATUSES.map((s) => s.value)).toEqual(['pending', 'in-progress', 'done'])
  })
})

describe('nextStatus', () => {
  it('cycles pending -> in-progress -> done -> pending', () => {
    expect(nextStatus('pending')).toBe('in-progress')
    expect(nextStatus('in-progress')).toBe('done')
    expect(nextStatus('done')).toBe('pending')
  })
})

describe('repairCounts', () => {
  it('counts the three tiles', () => {
    expect(repairCounts([R(), R({ status: 'in-progress' }), R({ status: 'done' }), R({ status: 'done' }), null])).toEqual({
      pending: 1,
      inProgress: 1,
      done: 2,
      total: 4,
    })
  })

  it('is zeros for nothing', () => {
    expect(repairCounts([]).total).toBe(0)
    expect(repairCounts(undefined).total).toBe(0)
  })
})

describe('costTotals', () => {
  it('counts only open repairs toward what is still ahead', () => {
    const totals = costTotals([
      R({ estimated_cost: 15000 }),
      R({ estimated_cost: '2500', status: 'in-progress' }),
      R({ estimated_cost: 40000, status: 'done' }),
      R({ estimated_cost: null }),
    ])
    expect(totals).toEqual({ openEstimate: 17500, allEstimate: 57500 })
  })

  it('ignores a negative or non-numeric estimate', () => {
    expect(costTotals([R({ estimated_cost: -5 }), R({ estimated_cost: 'soon' })])).toEqual({ openEstimate: 0, allEstimate: 0 })
  })
})

describe('filterRepairs', () => {
  it('shows all, or one priority', () => {
    const rows = [R({ id: 'a', priority: 'urgent' }), R({ id: 'b' }), R({ id: 'c', priority: 'someday' })]
    expect(filterRepairs(rows, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(filterRepairs(rows, 'someday').map((r) => r.id)).toEqual(['c'])
  })
})

describe('sortRepairs', () => {
  it('reads in-progress, then pending, then done; urgent first inside each; nearest due date first; undated last', () => {
    const rows = [
      R({ id: 'done-urgent', status: 'done', priority: 'urgent' }),
      R({ id: 'pending-someday' , priority: 'someday' }),
      R({ id: 'pending-soon-late', due_date: '2026-10-05' }),
      R({ id: 'pending-soon-early', due_date: '2026-09-25' }),
      R({ id: 'pending-soon-undated' }),
      R({ id: 'in-progress', status: 'in-progress', priority: 'someday' }),
      R({ id: 'pending-urgent', priority: 'urgent' }),
    ]
    expect(sortRepairs(rows).map((r) => r.id)).toEqual([
      'in-progress',
      'pending-urgent',
      'pending-soon-early',
      'pending-soon-late',
      'pending-soon-undated',
      'pending-someday',
      'done-urgent',
    ])
  })

  it('does not mutate its input', () => {
    const rows = [R({ id: 'b', status: 'done' }), R({ id: 'a' })]
    sortRepairs(rows)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('urgentRepairs', () => {
  it('is what deserves a nudge: open and urgent, or open and due', () => {
    const rows = [
      R({ id: 'urgent' , priority: 'urgent' }),
      R({ id: 'due', due_date: '2026-09-20' }),
      R({ id: 'later', due_date: '2026-10-20' }),
      R({ id: 'done-urgent', priority: 'urgent', status: 'done' }),
      R({ id: 'someday', priority: 'someday' }),
    ]
    expect(urgentRepairs(rows, '2026-09-22').map((r) => r.id)).toEqual(['urgent', 'due'])
  })
})
