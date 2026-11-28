import { summarizeMonth, TRANSFER_CATEGORIES } from '../../lib/summary'
import Panel from '../ui/Panel'
import Stat from '../ui/Stat'
import Money from '../ui/Money'

/**
 * What yesterday actually came to: what you spent, the one transaction that
 * dominated it, and how much of the plan you finished.
 *
 * Renders nothing when yesterday held neither spending nor tasks. An empty
 * card that says "₦0.00 spent · 0/0 done" takes the same space to say nothing.
 */
export default function Yesterday({ transactions, tasks, isDone, liquidWalletIds }) {
  const summary = summarizeMonth(transactions, liquidWalletIds)

  const total = tasks.length
  const done = tasks.filter((t) => isDone(t)).length

  // Biggest single debit, ignoring transfers: moving money to savings is not
  // the day's notable expense even when it is the day's largest number.
  const biggest = (transactions || [])
    .filter(
      (t) =>
        t.type === 'debit' &&
        !t.voided &&
        !TRANSFER_CATEGORIES.includes(t.category) &&
        (!t.wallet_id || !liquidWalletIds || liquidWalletIds.has(t.wallet_id)),
    )
    .reduce((max, t) => (Number(t.amount) > Number(max?.amount || 0) ? t : max), null)

  if (summary.spent === 0 && total === 0) return null

  return (
    // The only panel reporting on a day that is over; its label says so.
    <Panel label="Yesterday" meta="Closed">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Spent" value={<Money amount={summary.spent} kobo={false} />} />
        {total > 0 && <Stat label="Done" value={`${done} of ${total}`} />}
      </div>
      {biggest && (
        <p className="text-body-sm text-muted mt-2 flex items-baseline gap-1.5 min-w-0">
          <span className="truncate">Largest: {biggest.description || biggest.category}</span>
          <Money amount={biggest.amount} className="shrink-0 text-foreground" />
        </p>
      )}
    </Panel>
  )
}
