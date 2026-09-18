import { useRef } from 'react'
import { useDismissable } from '../../hooks/useDismissable'

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

  if (!isOpen) return null

  return (
    <>
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 animate-fade-in"
        onClick={onClose}
        // The backdrop is a convenience, not the only way out: Escape, the
        // back gesture and the sheet's own close control all work. Marked
        // hidden so it is not announced as an interactive element with no name.
        aria-hidden="true"
      />

      <div
        className={`fixed z-50 flex justify-center pointer-events-none ${
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
          className={`pointer-events-auto w-full ${maxWidth} bg-card border border-white/10 shadow-2xl overflow-hidden flex flex-col animate-slide-up max-h-[90vh] focus:outline-none ${
            alwaysCenter ? 'rounded-3xl' : desktopCenter ? 'rounded-t-3xl sm:rounded-3xl' : 'rounded-t-3xl'
          }`}
        >
          {children}
        </div>
      </div>
    </>
  )
}
