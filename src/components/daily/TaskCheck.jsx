import Icon from '../ui/Icon'

/**
 * The tick box for a task: a 22px box inside a 48px target. Done is an
 * accent fill with an on-accent check; open is an outline. `locked` draws
 * the same box with no button, for rows the ledger decides.
 */
export default function TaskCheck({ done, onClick, disabled, label, locked = false }) {
  const box = (
    <span
      aria-hidden="true"
      className={`w-[22px] h-[22px] rounded-chip flex items-center justify-center transition-colors duration-150 ${
        done ? 'bg-accent text-on-accent' : 'border-2 border-border-strong'
      }`}
    >
      {done && <Icon name="check" size={16} className="[stroke-width:2.5]" />}
    </span>
  )
  if (locked) return <span className="w-12 h-12 -ml-3 flex items-center justify-center shrink-0">{box}</span>
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={done}
      aria-label={label}
      className="w-12 h-12 -ml-3 flex items-center justify-center shrink-0 disabled:opacity-60"
    >
      {box}
    </button>
  )
}
