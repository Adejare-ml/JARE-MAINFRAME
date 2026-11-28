import { Link } from 'react-router-dom'
import { breakdownRows } from '../../lib/summary'
import Panel from './Panel'
import Money from './Money'
import CategoryMark from './CategoryMark'
import Icon from './Icon'

/**
 * Where this month's money went, as proportional bars.
 *
 * Rows link into the Transactions page pre-filtered to the category, so the
 * path from "why is Transport so high" to the actual rows is one tap.
 *
 * `budgetByCategory` and `averageByCategory` are both optional lookups
 * (category -> number). A category with a budget target gains a second bar
 * (share of its own budget, a different fraction from share of total spend),
 * and a category with a known historical average shows it beside this
 * month's figure. Share bars are neutral: colour is for state, so only the
 * budget bar turns red when over.
 */
export default function CategoryBreakdown({ byCategory, budgetByCategory = {}, averageByCategory = {} }) {
  const rows = breakdownRows(byCategory, budgetByCategory)

  if (rows.length === 0) return null

  return (
    <Panel label="Where it went" flush>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const isOther = row.category === 'Other'
          const average = isOther ? null : averageByCategory?.[row.category]
          const inner = (
            <>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2.5 min-w-0">
                  {isOther ? (
                    <span aria-hidden="true" className="inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-chip bg-surface-2 text-muted">
                      <Icon name="box" size={16} />
                    </span>
                  ) : (
                    <CategoryMark category={row.category} />
                  )}
                  <span className="text-body text-foreground truncate">{row.category}</span>
                  <span className="type-data text-muted-dim shrink-0">{Math.round(row.share * 100)}%</span>
                </span>
                <span className="text-right shrink-0">
                  <Money amount={row.total} className="block" />
                  {average != null && (
                    <span className="block type-data text-muted-dim">
                      avg <Money amount={average} tone="muted" className="font-normal" />
                    </span>
                  )}
                </span>
              </div>
              <div className="h-1 mt-2 bg-surface-2 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-border-strong" style={{ width: `${Math.max(2, row.share * 100)}%` }} />
              </div>
              {row.target != null && (
                <div className="mt-1.5">
                  <div className="h-1 bg-surface-2 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${row.overBudget ? 'bg-danger' : 'bg-accent'}`}
                      style={{ width: `${Math.max(2, Math.min(100, (row.total / row.target) * 100))}%` }}
                    />
                  </div>
                  <p className={`text-body-sm mt-1 ${row.overBudget ? 'text-danger' : 'text-muted'}`}>
                    {row.overBudget ? (
                      <>
                        <Money amount={row.total - row.target} tone="danger" /> over the <Money amount={row.target} tone="muted" /> budget
                      </>
                    ) : (
                      <>
                        <Money amount={row.target - row.total} tone="muted" /> left of <Money amount={row.target} tone="muted" />
                      </>
                    )}
                  </p>
                </div>
              )}
            </>
          )

          return isOther ? (
            <div key={row.category} className="px-3 py-3">
              {inner}
            </div>
          ) : (
            <Link
              key={row.category}
              to={`/transactions?category=${encodeURIComponent(row.category)}`}
              className="block px-3 py-3 transition-colors duration-150 hover:bg-surface-2 active:bg-surface-2"
            >
              {inner}
            </Link>
          )
        })}
      </div>
    </Panel>
  )
}
