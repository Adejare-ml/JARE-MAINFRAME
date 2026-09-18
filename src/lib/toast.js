const DEFAULT_DURATION = { success: 3000, error: 6000, info: 5000 }

// Simple event-driven Toast notification bus
class ToastManager {
  constructor() {
    this.listeners = []
  }

  subscribe(listener) {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }

  /**
   * @param {string} message
   * @param {'success'|'error'|'info'} type
   * @param {number|object} opts - a bare number is treated as `duration`
   *   (the original signature, still accepted so no existing call site
   *   breaks); an object may carry:
   *   - duration: ms, 0 for sticky
   *   - color: a Tailwind bg-* class tinting a small dot next to the message
   *     (e.g. the category colour of what was just logged) -- never the
   *     toast's own background, so a category that happens to map to red
   *     cannot read as an error.
   *   - action: {label, onClick} rendered as a button, e.g. "Undo"
   */
  show(message, type = 'success', opts = {}) {
    const { duration, color = null, action = null } =
      typeof opts === 'number' ? { duration: opts } : opts
    const resolvedDuration = duration ?? DEFAULT_DURATION[type] ?? 3000
    this.listeners.forEach(l =>
      l({ message, type, duration: resolvedDuration, color, action, id: Date.now() + Math.random() }),
    )
  }

  success(message, opts) {
    this.show(message, 'success', opts)
  }

  error(message, opts) {
    // Long enough to read, but it must go away: an undismissed error card used
    // to park itself over the QuickLog button -- exactly the button needed to
    // retry the action that failed. Pass 0 explicitly for a sticky toast.
    this.show(message, 'error', opts)
  }

  info(message, opts) {
    this.show(message, 'info', opts)
  }
}

export const toast = new ToastManager()
