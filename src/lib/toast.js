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

  error(message, duration = 0) {
    // Error stays until dismissed by default or auto-dismiss if specified
    this.show(message, 'error', duration)
  }

  info(message, duration = 5000) {
    this.show(message, 'info', duration)
  }
}

export const toast = new ToastManager()
