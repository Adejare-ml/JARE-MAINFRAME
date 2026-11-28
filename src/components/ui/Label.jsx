/**
 * Text in the `label` step: Plex Mono 12/16, weight 500, 0.06em, uppercase.
 * The only place uppercase is allowed. Muted by default.
 *
 * @param {object} props
 * @param {React.ElementType} [props.as] - default span
 * @param {string} [props.className] - layout only (margins, colour override)
 */
export default function Label({ children, as: As = 'span', className = '', ...rest }) {
  return (
    <As className={`type-label text-muted ${className}`} {...rest}>
      {children}
    </As>
  )
}
