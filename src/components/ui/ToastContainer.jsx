import { useState, useEffect, useCallback } from 'react'
import { toast } from '../../lib/toast'
import StatusDot from './StatusDot'
import Icon from './Icon'

/** Matches --dur-state: the exit runs, then the toast unmounts. */
const EXIT_MS = 180

export default function ToastContainer() {
  const [toasts, setToasts] = useState([])

  // Mark leaving (the exit transition runs), then drop it.
  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), EXIT_MS)
  }, [])

  useEffect(() => {
    const unsubscribe = toast.subscribe((newToast) => {
      setToasts((prev) => [...prev, newToast])
      if (newToast.duration > 0) setTimeout(() => removeToast(newToast.id), newToast.duration)
    })
    return unsubscribe
  }, [removeToast])

  if (toasts.length === 0) return null

  return (
    // bottom-36, not bottom-20: the QuickLog floating button occupies
    // bottom-20 right-4 (80-136px up from the bottom), and on a 390px phone the
    // toast card spans the same rectangle. A failed action used to park its
    // error card directly over the button needed to retry it.
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-36 lg:bottom-8 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none"
    >
      {toasts.map((t) => {
        // Type is carried by a leading dot plus the words, never by the
        // card's own fill: every toast is a plain card.
        const dot = t.type === 'error' ? 'danger' : t.type === 'success' ? 'accent' : 'muted'
        return (
          <div
            key={t.id}
            data-leaving={t.leaving ? 'true' : undefined}
            className={`toast pointer-events-auto flex items-center justify-between gap-2 pl-3 pr-1 min-h-12 rounded-control border bg-card text-body-sm text-foreground ${
              t.type === 'error' ? 'border-danger' : 'border-border-strong'
            }`}
          >
            <span className="flex items-center gap-2.5 min-w-0 py-2">
              <StatusDot status={dot} />
              <span className="min-w-0">{t.message}</span>
            </span>
            <span className="flex items-center shrink-0">
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action.onClick()
                    removeToast(t.id)
                  }}
                  className="px-3 min-h-12 text-body-sm font-semibold text-accent"
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                onClick={() => removeToast(t.id)}
                aria-label="Dismiss notification"
                className="w-12 h-12 flex items-center justify-center text-muted hover:text-foreground"
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}
