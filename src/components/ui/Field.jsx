import { useId } from 'react'
import Label from './Label'

/**
 * A form field: a `label`-step label, the control, then hint or error text.
 * Controls are surface-2 with a border, border-strong on focus, 48px high,
 * and render at 16px so iOS does not zoom on focus.
 *
 * Use Field directly around a custom control (it passes `id` and the
 * described-by id to a render-prop child), or Input / Select / Textarea,
 * which wrap themselves in a Field when given a `label`.
 *
 * @param {object} props
 * @param {React.ReactNode} [props.label]
 * @param {React.ReactNode} [props.hint]
 * @param {React.ReactNode} [props.error] - shown in danger, sets aria-invalid
 */
export function Field({ label, hint, error, id, children }) {
  const auto = useId()
  const fieldId = id || auto
  const noteId = `${fieldId}-note`
  const note = error || hint
  const control = typeof children === 'function'
    ? children({ id: fieldId, describedBy: note ? noteId : undefined, invalid: Boolean(error) })
    : children
  return (
    <div className="space-y-1.5">
      {label && (
        <Label as="label" htmlFor={fieldId} className="block">
          {label}
        </Label>
      )}
      {control}
      {note && (
        <p id={noteId} className={`text-body-sm ${error ? 'text-danger' : 'text-muted'}`}>
          {note}
        </p>
      )}
    </div>
  )
}

export const controlClasses = (invalid = false) =>
  `w-full min-h-12 px-3 bg-surface-2 text-foreground text-[16px] leading-6 rounded-control border placeholder:text-hint focus:outline-none focus:border-border-strong disabled:opacity-50 ${
    invalid ? 'border-danger' : 'border-border'
  }`

function wrap(render) {
  return function Control({ label, hint, error, id, className = '', ...rest }) {
    return (
      <Field label={label} hint={hint} error={error} id={id}>
        {({ id: fieldId, describedBy, invalid }) =>
          render({
            id: fieldId,
            'aria-describedby': describedBy,
            'aria-invalid': invalid || undefined,
            className: `${controlClasses(invalid)} ${className}`,
            ...rest,
          })
        }
      </Field>
    )
  }
}

export const Input = wrap((props) => <input {...props} />)
export const Textarea = wrap((props) => <textarea {...props} className={`${props.className} py-3 resize-none`} />)
export const Select = wrap(({ children, ...props }) => <select {...props}>{children}</select>)

export default Field
