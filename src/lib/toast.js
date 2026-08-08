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

  show(message, type = 'success', duration = 3000) {
    this.listeners.forEach(l => l({ message, type, duration, id: Date.now() + Math.random() }))
  }

  success(message, duration = 3000) {
    this.show(message, 'success', duration)
  }

  error(message, duration = 6000) {
    // Long enough to read, but it must go away: an undismissed error card used
    // to park itself over the QuickLog button -- exactly the button needed to
    // retry the action that failed. Pass 0 explicitly for a sticky toast.
    this.show(message, 'error', duration)
  }

  info(message, duration = 5000) {
    this.show(message, 'info', duration)
  }
}

export const toast = new ToastManager()
