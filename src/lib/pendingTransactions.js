/**
 * Transactions shown before the server has confirmed them.
 *
 * QuickLog is a global floating action button, mounted independently of
 * whatever page is showing -- it cannot push directly into Transactions.jsx's
 * state, so this is the same event-bus shape lib/toast.js already uses to
 * cross that same gap.
 *
 * Self-healing by design: every entry carries a hard TTL. If the real row
 * never arrives to trigger the realtime refetch that would otherwise clear
 * it -- a dropped event, a bug here, anything -- the placeholder quietly
 * disappears on its own rather than lingering forever as a transaction that
 * was never really there. The real row is already safely in the database
 * either way; this bus only ever affects what is shown before that.
 */

const TTL_MS = 8000

class PendingTransactions {
  constructor() {
    this.items = new Map()
    this.listeners = []
  }

  subscribe(listener) {
    this.listeners.push(listener)
    listener(this.list())
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  list() {
    return [...this.items.values()]
  }

  emit() {
    const snapshot = this.list()
    this.listeners.forEach((l) => l(snapshot))
  }

  /** @returns {string} the entry's id, for a matching remove() call */
  add(entry) {
    this.items.set(entry.id, entry)
    this.emit()
    setTimeout(() => this.remove(entry.id), TTL_MS)
    return entry.id
  }

  remove(id) {
    if (this.items.delete(id)) this.emit()
  }
}

export const pendingTransactions = new PendingTransactions()
