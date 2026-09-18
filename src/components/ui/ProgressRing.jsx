/**
 * A circular progress indicator, hand-rolled in SVG -- no chart library
 * exists in this project, and one ring does not justify adding one.
 *
 * Animates by itself: the fill is a plain CSS transition on stroke-dashoffset,
 * so a re-render with a new `value` eases from the old ring to the new one
 * without any JS animation loop. That is also what makes it safe to reuse for
 * every ring in the app (Budget's category donuts, a Goal's target) rather
 * than hand-writing the same geometry three times.
 *
 * @param {object} props
 * @param {number} props.value - 0 to 1. Values outside that range are clamped,
 *   since a >100%-funded goal is still a full ring, not an overflowing one.
 * @param {number} [props.size] - px, default 96
 * @param {number} [props.strokeWidth] - px, default 8
 * @param {string} [props.color] - stroke color for the filled arc, default var(--color-accent)
 * @param {string} [props.trackColor] - stroke color for the empty track
 * @param {React.ReactNode} [props.children] - rendered centered inside the ring
 */
export default function ProgressRing({
  value,
  size = 96,
  strokeWidth = 8,
  color = 'var(--color-accent)',
  trackColor = 'rgba(255,255,255,0.08)',
  children,
}) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - clamped)

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={trackColor} strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center">{children}</div>
      )}
    </div>
  )
}
