import { useState, useEffect } from 'react'
import { toast } from '../../lib/toast'

export default function ToastContainer() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    const unsubscribe = toast.subscribe((newToast) => {
      setToasts(prev => [...prev, newToast])

      if (newToast.duration > 0) {
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== newToast.id))
        }, newToast.duration)
      }
    })

    return unsubscribe
  }, [])

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-sm px-4 pointer-events-none">
      {toasts.map(t => {
        const bg = t.type === 'success' ? 'bg-accent/90 text-black border-emerald-400' :
                   t.type === 'error' ? 'bg-red-500/90 text-white border-red-400' :
                   'bg-card/90 text-white border-white/20'

        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center justify-between gap-3 px-4 py-3 rounded-xl border backdrop-blur-md shadow-lg text-sm font-medium transition-all duration-300 animate-slide-up ${bg}`}
          >
            <span>{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              className="text-xs opacity-70 hover:opacity-100 p-1 min-w-[24px] min-h-[24px] flex items-center justify-center"
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
