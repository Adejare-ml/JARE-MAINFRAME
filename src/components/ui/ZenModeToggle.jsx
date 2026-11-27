import { useState } from 'react'
import { isZenEnabled, setZenEnabled } from '../../lib/privacy'
import IconButton from './IconButton'

/**
 * One tap, from anywhere: blur the figures on screen for whoever is next to
 * you on the bus. See src/lib/privacy.js.
 */
export default function ZenModeToggle({ className = '' }) {
  const [enabled, setEnabled] = useState(isZenEnabled)

  return (
    <IconButton
      name={enabled ? 'eyeOff' : 'eye'}
      label={enabled ? 'Show figures' : 'Hide figures'}
      aria-pressed={enabled}
      className={className}
      onClick={() => {
        const next = !enabled
        setZenEnabled(next)
        setEnabled(next)
      }}
    />
  )
}
