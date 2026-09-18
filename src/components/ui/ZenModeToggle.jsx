import { useState } from 'react'
import { isZenEnabled, setZenEnabled } from '../../lib/privacy'

/**
 * One tap, from anywhere: blur the figures on screen for whoever is next to
 * you on the bus. See src/lib/privacy.js.
 */
export default function ZenModeToggle({ className = '' }) {
  const [enabled, setEnabled] = useState(isZenEnabled)

  return (
    <button
      type="button"
      onClick={() => {
        const next = !enabled
        setZenEnabled(next)
        setEnabled(next)
      }}
      aria-pressed={enabled}
      aria-label={enabled ? 'Show figures' : 'Hide figures'}
      title={enabled ? 'Show figures' : 'Hide figures'}
      className={className}
    >
      <span aria-hidden="true">{enabled ? '🙈' : '👁️'}</span>
    </button>
  )
}
