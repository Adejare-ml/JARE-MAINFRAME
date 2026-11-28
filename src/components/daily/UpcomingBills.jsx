import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { formatDate } from '../../lib/formatters'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Money from '../ui/Money'
import StatusDot from '../ui/StatusDot'
import { excludeVoided, daysAgo, transactionRecurrenceColumns, toDateOnly } from '../../lib/queries'
import { daysUntil } from '../../lib/debts'
import { detectRecurring } from '../../lib/recurring'

/**
 * Bills the app has never been told about, surfaced from the pattern alone --
 * three or more debits to the same place at a consistent amount and interval
 * is a subscription or a standing payment whether or not anyone typed it in
 * as a debt. See src/lib/recurring.js for the detection itself.
 *
 * A wider window than Daily HQ's own fetch: three monthly occurrences need
 * roughly ninety days of history, well past what the page loads for its own
 * cards. Self-contained for the same reason CashReconciliation and
 * CategoryRules are -- its own fetch, so the page's central Promise.all does
 * not grow a query that only this card needs.
 */

const LOOKBACK_DAYS = 100
const HORIZON_DAYS = 10

export default function UpcomingBills() {
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    excludeVoided(
      supabase
        .from('transactions')
        .select(transactionRecurrenceColumns())
        .gte('transaction_date', daysAgo(LOOKBACK_DAYS)),
    ).then(({ data, error }) => {
      if (cancelled) return
      if (error) console.warn('Could not load transactions for bill detection:', error.message)
      setTransactions(error ? [] : data || [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading) return null

  const today = toDateOnly(new Date())
  const dueSoon = detectRecurring(transactions, today)
    .filter((c) => c.type === 'debit')
    .filter((c) => c.overdue || (daysUntil(c.nextExpected) ?? 999) <= HORIZON_DAYS)

  // Nothing detected, or nothing due soon -- an empty card teaches nothing a
  // missing one doesn't, same reasoning as Yesterday's early return.
  if (dueSoon.length === 0) return null

  return (
    <Panel label="Upcoming bills" meta={`${dueSoon.length} due`} flush>
      <ListRows>
        {dueSoon.map((c) => (
          <ListRow
            key={c.key}
            leading={<StatusDot status={c.overdue ? 'warn' : 'muted'} />}
            title={c.label}
            subtitle={`${c.overdue ? 'Expected' : 'Due'} ${formatDate(c.nextExpected)} · ${c.interval}`}
            trailing={<Money amount={c.amount} />}
          />
        ))}
      </ListRows>
    </Panel>
  )
}
