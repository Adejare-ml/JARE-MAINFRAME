import { useEffect, useRef } from 'react'

/**
 * Make an open overlay behave like something you can back out of.
 *
 * Three things, all of which were missing everywhere in the app:
 *
 * 1. **The Android back gesture closes it.** There was no `popstate` handler
 *    anywhere in `src/`, so swiping back with QuickLog open left the app
 *    entirely -- losing a half-typed transaction -- rather than closing the
 *    sheet. This is the whole reason the hook exists.
 * 2. **Escape closes it**, for the desktop half of the same expectation.
 * 3. **The page behind stops scrolling**, and gets its scroll position back
 *    when the sheet closes. `overflow: hidden` alone jumps iOS Safari to the
 *    top; pinning `top` and restoring it is what keeps the place.
 *
 * 4. **Focus moves in and comes back out.** Optional, via `panelRef` -- an
 *    overlay that leaves focus on the page behind means a screen reader is
 *    reading one thing while the eyes are on another.
 *
 * The history bookkeeping is the fiddly part, and it has to hold in two modes.
 *
 * Exactly one entry is pushed per open and exactly one consumed per close. A
 * double push means two back presses to leave the page afterwards; skipping
 * the pop means a dead back press for every sheet ever opened, accumulating.
 *
 * The push is *deferred by a task and cancellable*, which is what makes this
 * survive StrictMode. React double-invokes effects in development: mount,
 * unmount, mount. Pushing synchronously would have the first cleanup call
 * `history.back()`, and the resulting popstate would land after the second
 * mount had already registered its listener -- closing the sheet the instant
 * it opened, in dev only. Deferring means the first pass is cancelled before
 * it ever pushes, so there is no stray pop to catch. The cost is a sub-frame
 * window where a back press leaves the page instead of closing the sheet.
 *
 * On close-by-button the entry we pushed is still on the stack, so cleanup
 * consumes it with `history.back()`. The listener is removed first, so that
 * pop calls nothing.
 *
 * @param {boolean} isOpen
 * @param {() => void} onClose
 * @param {React.RefObject<HTMLElement>} [panelRef] - the dialog element
 */
export function useDismissable(isOpen, onClose, panelRef) {
  // A ref, not state: the cleanup needs the value at teardown, and changing it
  // must never trigger a render.
  const pushedRef = useRef(false)
  // So the effect does not re-run every render when the caller passes an
  // inline arrow, which would push a fresh history entry each time.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!isOpen) return

    const scrollY = window.scrollY
    const opener = document.activeElement

    const pushTimer = setTimeout(() => {
      window.history.pushState({ sheet: true }, '')
      pushedRef.current = true
    }, 0)

    // The panel rather than its first field: on Android, focusing an input
    // pops the keyboard immediately and covers the sheet you have just
    // opened, before you have seen what is in it.
    panelRef?.current?.focus()

    const handlePop = () => {
      // The entry is gone -- the browser consumed it -- so the cleanup below
      // must not try to consume it again.
      pushedRef.current = false
      onCloseRef.current()
    }

    const handleKey = (e) => {
      if (e.key === 'Escape') onCloseRef.current()
    }

    window.addEventListener('popstate', handlePop)
    document.addEventListener('keydown', handleKey)

    const { body } = document
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'
    body.style.overflow = 'hidden'

    return () => {
      clearTimeout(pushTimer)
      window.removeEventListener('popstate', handlePop)
      document.removeEventListener('keydown', handleKey)

      body.style.position = previous.position
      body.style.top = previous.top
      body.style.width = previous.width
      body.style.overflow = previous.overflow
      window.scrollTo(0, scrollY)

      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus()
      }

      // Closed by a button rather than by going back: the entry we pushed is
      // still on the stack and has to be consumed, or the next back press
      // would appear to do nothing. False when the pop already happened, and
      // false when the deferred push was cancelled above -- so neither path
      // pops an entry that is not ours.
      if (pushedRef.current) {
        pushedRef.current = false
        window.history.back()
      }
    }
    // panelRef is intentionally not a dependency: it is a stable ref object,
    // and listing it would suggest the effect should re-run when .current
    // changes, which is exactly the double-push bug described above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])
}
