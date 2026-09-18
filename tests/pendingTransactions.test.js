import { describe, it, expect, vi, afterEach } from 'vitest'
import { pendingTransactions } from '../src/lib/pendingTransactions.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('pendingTransactions', () => {
  it('delivers a snapshot immediately on subscribe', () => {
    const seen = []
    const unsubscribe = pendingTransactions.subscribe((list) => seen.push(list))
    unsubscribe()
    expect(seen).toEqual([[]])
  })

  it('notifies subscribers when an entry is added, then removed', () => {
    const seen = []
    const unsubscribe = pendingTransactions.subscribe((list) => seen.push(list.length))

    const id = pendingTransactions.add({ id: 'a', type: 'debit', amount: 100, category: 'Transport' })
    pendingTransactions.remove(id)

    unsubscribe()
    expect(seen).toEqual([0, 1, 0])
  })

  it('removing an id that is not there is a silent no-op', () => {
    const seen = []
    const unsubscribe = pendingTransactions.subscribe((list) => seen.push(list.length))
    pendingTransactions.remove('never-added')
    unsubscribe()
    // Only the initial snapshot -- a no-op removal must not fire a spurious update.
    expect(seen).toEqual([0])
  })

  it('a second add() with the same id replaces rather than duplicates', () => {
    pendingTransactions.add({ id: 'dup', type: 'debit', amount: 100, category: 'Transport' })
    pendingTransactions.add({ id: 'dup', type: 'debit', amount: 200, category: 'Transport' })
    expect(pendingTransactions.list()).toHaveLength(1)
    expect(pendingTransactions.list()[0].amount).toBe(200)
    pendingTransactions.remove('dup')
  })

  it('self-clears after its TTL even if remove() is never called', () => {
    vi.useFakeTimers()
    pendingTransactions.add({ id: 'ttl', type: 'debit', amount: 50, category: 'Transport' })
    expect(pendingTransactions.list()).toHaveLength(1)

    vi.advanceTimersByTime(8000)
    expect(pendingTransactions.list()).toHaveLength(0)
  })
})
