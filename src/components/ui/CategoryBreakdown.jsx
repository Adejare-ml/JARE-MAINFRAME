import { Link } from 'react-router-dom'
import { formatNaira, getCategoryColor } from '../../lib/formatters'
import { getCategoryIcon } from '../../lib/constants'
import { breakdownRows } from '../../lib/summary'

/**
 * Where this month's money went, as proportional bars.
 *
 * Rows link into the Transactions page pre-filtered to the category, so the
 * path from "why is Transport so high" to the actual rows is one tap.
 *
 * `budgetByCategory` and `averageByCategory` are both optional lookups
 * (category -> number); every existing caller that passes neither renders
 * exactly as before. A category with a budget target gains a second,
 * independent bar -- share-of-total-spend and share-of-its-own-budget are
 * different fractions, and one is not the other scaled -- and a category
 * with a known historical average shows it beside this month's own figure.
 */
export default function CategoryBreakdown({ byCategory, budgetByCategory = {}, averageByCategory = {} }) {
  const rows = breakdownRows(byCategory, budgetByCategory)

  if (rows.length === 0) return null

  return (
    <div className="bg-card rounded-3xl p-6 border border-white/5">
      <h3 className="text-lg font-bold text-white mb-5">WHERE IT WENT</h3>
      <div className="space-y-4">
        {rows.map((row) => {
          const isOther = row.category === 'Other'
          // "Other" folds several categories together; there is no single
          // average to show for it.
          const average = isOther ? null : averageByCategory?.[row.category]
          const inner = (
            <>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm text-white flex items-center gap-2 min-w-0">
                  <span className="flex-shrink-0">{isOther ? '📦' : getCategoryIcon(row.category)}</span>
                  <span className="truncate">{row.category}</span>
                  <span className="text-[10px] text-muted flex-shrink-0">
                    {Math.round(row.share * 100)}%
                  </span>
                </span>
                <span className="text-right flex-shrink-0">
                  <span className="block text-sm font-bold text-white tabular-nums money">
                    {formatNaira(row.total)}
                  </span>
                  {average != null && (
                    <span className="block text-[10px] text-muted-dim tabular-nums money">
                      avg {formatNaira(average)}
                    </span>
                  )}
                </span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${isOther ? 'bg-gray-500' : getCategoryColor(row.category)}`}
                  style={{ width: `${Math.max(2, row.share * 100)}%` }}
                />
              </div>
              {/* The envelope: how much of THIS category's own budget is
                  used up, not how much of total spend it accounts for. */}
              {row.target != null && (
                <div className="mt-1.5">
                  <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${row.overBudget ? 'bg-red-500' : 'bg-accent'}`}
                      style={{ width: `${Math.max(2, Math.min(100, (row.total / row.target) * 100))}%` }}
                    />
                  </div>
                  <p className={`text-[10px] mt-1 ${row.overBudget ? 'text-red-400' : 'text-muted-dim'}`}>
                    {row.overBudget ? (
                      <>
                        <span className="money">{formatNaira(row.total - row.target)}</span> over the{' '}
                        <span className="money">{formatNaira(row.target)}</span> budget
                      </>
                    ) : (
                      <>
                        <span className="money">{formatNaira(row.target - row.total)}</span> left of{' '}
                        <span className="money">{formatNaira(row.target)}</span>
                      </>
                    )}
                  </p>
                </div>
              )}
            </>
          )

          // "Other" folds several categories, so there is no single filter to
          // link to -- it goes to the unfiltered list instead.
          return isOther ? (
            <div key={row.category}>{inner}</div>
          ) : (
            <Link
              key={row.category}
              to={`/transactions?category=${encodeURIComponent(row.category)}`}
              className="block hover:opacity-80 transition-opacity"
            >
              {inner}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
