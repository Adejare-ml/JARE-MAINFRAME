import { formatNaira } from '../../lib/formatters'
import { summarizeMonth } from '../../lib/summary'

/**
 * What yesterday actually came to.
 *
 * Dayflow opens its standup with yesterday's highlights, on the reasoning that
 * you cannot say what today should be without knowing how the last one went.
 * The money equivalent: what you spent, the one transaction that dominated it,
 * and how much of the plan you finished.
 *
 * Renders nothing at all when yesterday held neither spending nor tasks. An
 * empty card that says "₦0.00 spent · 0/0 done" is worse than no card -- it
 * takes up the same space to tell you nothing.
 */
export default function Yesterday({ transactions, tasks, isDone, liquidWalletIds }) {
  const summary = summarizeMonth(transactions, liquidWalletIds)

  const total = tasks.length
  const done = tasks.filter((t) => isDone(t)).length

  // Biggest single debit, ignoring transfers -- moving money to savings is not
  // the day's notable expense even when it is the day's largest number.
  const biggest = (transactions || [])
    .filter((t) => t.type === 'debit' && !t.voided)
    .reduce((max, t) => (Number(t.amount) > Number(max?.amount || 0) ? t : max), null)

  if (summary.spent === 0 && total === 0) return null

  return (
    // Dashed border and a dimmer surface, deliberately unlike every other
    // card on this page -- this one is the only section reporting on a day
    // that is already over, and it should read that way at a glance, not
    // just by the word "Yesterday" in its heading.
    <section className="bg-card/60 rounded-3xl p-6 border border-dashed border-white/10 space-y-3">
      <h2 className="text-xs font-semibold text-muted-dim uppercase tracking-wider flex items-center gap-1.5">
        <span aria-hidden="true">◐</span> Yesterday
      </h2>

      <div className="flex items-baseline gap-4 flex-wrap">
        <p className="text-lg font-bold text-white/80 tabular-nums money">
          {formatNaira(summary.spent)}
          <span className="text-muted text-xs font-normal"> spent</span>
        </p>
        {total > 0 && (
          <p className="text-lg font-bold text-white/80 tabular-nums">
            {done}
            <span className="text-muted text-xs font-normal">/{total} done</span>
          </p>
        )}
      </div>

      {biggest && (
        <p className="text-xs text-muted">
          Largest: {biggest.description || biggest.category} ·{' '}
          <span className="text-white/80 font-semibold money">{formatNaira(biggest.amount)}</span>
        </p>
      )}
    </section>
  )
}
