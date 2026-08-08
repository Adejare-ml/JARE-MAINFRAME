import { Link } from 'react-router-dom'
import { formatNaira, getCategoryColor } from '../../lib/formatters'
import { getCategoryIcon } from '../../lib/constants'
import { breakdownRows } from '../../lib/summary'

/**
 * Where this month's money went, as proportional bars.
 *
 * Rows link into the Transactions page pre-filtered to the category, so the
 * path from "why is Transport so high" to the actual rows is one tap.
 */
export default function CategoryBreakdown({ byCategory }) {
  const rows = breakdownRows(byCategory)

  if (rows.length === 0) return null

  return (
    <div className="bg-card rounded-3xl p-6 border border-white/5">
      <h3 className="text-lg font-bold text-white mb-5">WHERE IT WENT</h3>
      <div className="space-y-4">
        {rows.map((row) => {
          const isOther = row.category === 'Other'
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
                <span className="text-sm font-bold text-white flex-shrink-0 tabular-nums">
                  {formatNaira(row.total)}
                </span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${isOther ? 'bg-gray-500' : getCategoryColor(row.category)}`}
                  style={{ width: `${Math.max(2, row.share * 100)}%` }}
                />
              </div>
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
