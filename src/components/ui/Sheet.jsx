import { useEffect, useRef, useState } from 'react'
import { useDismissable } from '../../hooks/useDismissable'

/** Drag the panel down this many pixels and releasing dismisses it. */
const DISMISS_THRESHOLD = 100
/** Matches --dur-sheet-exit in index.css: how long the exit runs before unmount. */
const EXIT_MS = 200

/**
 * A bottom sheet you can back out of.
 *
 * Three overlays existed in the app -- QuickLog, the wallet editor in Settings,
 * and the Debts form -- and each hand-rolled its own backdrop. None of them
 * announced itself as a dialog, none handled Escape, none locked the page
 * behind, and none closed on the Android back gesture. This is the one place
 * that behaviour lives now.
 *
 * Focus moves in on open and returns to whatever opened it on close, because a
 * sheet that leaves focus on the page behind means a screen reader is reading
 * one thing while the eyes are on another.
 *
 * `desktopCenter` widens this for forms that were their own centred-on-desktop
 * modal before this component existed (Debts, GoalForm): still a bottom sheet
 * on a phone, but a floating centred card above `sm:`, matching the layout
 * they already had rather than flattening every dialog in the app into a
 * bottom sheet regardless of screen size.
 *
 * `alwaysCenter` covers the third shape found in the app (Settings' wallet
 * editor): centred on every screen size, never a bottom sheet, because that
 * was this dialog's own deliberate choice, not an oversight to correct.
 *
 * Both off by default so QuickLog's existing always-bottom-anchored
 * behaviour is unchanged.
 *
 * A drag handle at the top lets a bottom-anchored sheet (`alwaysCenter`
 * false) be swiped down to dismiss, not just tapped away via the backdrop --
 * hidden above `sm:` when `desktopCenter` turns it into a centred card,
 * since dragging a centred dialog down is not the same gesture.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 * @param {string} props.title - accessible name; pass the heading the sheet shows
 * @param {React.ReactNode} props.children
 * @param {string} [props.maxWidth] - tailwind class, defaults to max-w-lg
 * @param {boolean} [props.desktopCenter] - centre as a card on sm: and up, bottom sheet below it
 * @param {boolean} [props.alwaysCenter] - centre as a card on every screen size
 */
export default function Sheet({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'max-w-lg',
  desktopCenter = false,
  alwaysCenter = false,
}) {
  const panelRef = useRef(null)
  useDismissable(isOpen, onClose, panelRef)

  // Drag-to-dismiss. Only downward movement is tracked -- this is a bottom
  // sheet, not a draggable window -- and only far enough past
  // DISMISS_THRESHOLD actually closes it; anything less snaps back, so a
  // scroll gesture that starts on the handle by mistake does not close the
  // sheet on a small, accidental movement.
  const [dragY, setDragY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStartY = useRef(0)

  const handleDragStart = (e) => {
    setDragging(true)
    dragStartY.current = e.clientY
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const handleDragMove = (e) => {
    if (!dragging) return
    const delta = e.clientY - dragStartY.current
    if (delta > 0) setDragY(delta)
  }
  const handleDragEnd = () => {
    if (!dragging) return
    setDragging(false)
    if (dragY > DISMISS_THRESHOLD) onClose()
    setDragY(0)
  }

  // Stay mounted for the exit: translateY out (or fade, when centred), then
  // unmount. Entry needs no state: `@starting-style` in index.css runs it.
  const [mounted, setMounted] = useState(isOpen)
  const [closing, setClosing] = useState(false)
  const [prevOpen, setPrevOpen] = useState(isOpen)
  if (isOpen !== prevOpen) {
    // Adjusting state during render, not in an effect: React re-renders
    // once with the new values before painting.
    setPrevOpen(isOpen)
    if (isOpen) {
      setMounted(true)
      setClosing(false)
    } else if (mounted) {
      const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      if (reduce) setMounted(false)
      else setClosing(true)
    }
  }
  useEffect(() => {
    if (!closing) return undefined
    const t = setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, EXIT_MS)
    return () => clearTimeout(t)
  }, [closing])

  if (!mounted) return null
  const state = closing ? 'closing' : 'open'
  const centred = alwaysCenter

  // A centred dialog is not something you drag down to dismiss -- that
  // gesture belongs to a sheet anchored to an edge.
  const draggable = !alwaysCenter

  return (
    <>
      <div
        className="sheet-scrim fixed inset-0 z-50"
        data-state={state}
        onClick={closing ? undefined : onClose}
        // The backdrop is a convenience, not the only way out: Escape, the
        // back gesture and the sheet's own close control all work. Marked
        // hidden so it is not announced as an interactive element with no name.
        aria-hidden="true"
      />

      <div
        className={`fixed z-50 flex justify-center pointer-events-none ${closing ? '[&_*]:pointer-events-none' : ''} ${
          alwaysCenter
            ? 'inset-0 items-center p-4'
            : desktopCenter
              ? 'inset-0 items-end sm:items-center p-0 sm:p-4'
              : 'bottom-0 left-0 right-0'
        }`}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          tabIndex={-1}
          data-state={state}
          data-center={centred ? 'true' : undefined}
          style={
            dragY
              ? { transform: `translateY(${dragY}px)`, transition: dragging ? 'none' : 'transform var(--dur-state) var(--ease-out)' }
              : undefined
          }
          className={`sheet-panel pointer-events-auto w-full ${maxWidth} bg-card border border-border overflow-hidden flex flex-col max-h-[90vh] focus:outline-none ${
            alwaysCenter ? 'rounded-sheet' : desktopCenter ? 'rounded-t-sheet sm:rounded-sheet' : 'rounded-t-sheet'
          }`}
        >
          {draggable && (
            <div
              onPointerDown={handleDragStart}
              onPointerMove={handleDragMove}
              onPointerUp={handleDragEnd}
              onPointerCancel={handleDragEnd}
              className={`w-full flex justify-center py-2.5 flex-shrink-0 touch-none cursor-grab active:cursor-grabbing ${
                desktopCenter ? 'sm:hidden' : ''
              }`}
              aria-hidden="true"
            >
              <span className="w-10 h-1 rounded-full bg-border" />
            </div>
          )}
          {children}
        </div>
      </div>
    </>
  )
}
