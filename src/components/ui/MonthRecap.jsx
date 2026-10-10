/**
 * The month in review, from src/lib/monthRecap.js -- sentences the page
 * computed, shown as they are. Renders nothing for a month with no rows.
 */
export default function MonthRecap({ sentences = [], title = 'MONTH IN REVIEW' }) {
  if (!sentences || sentences.length === 0) return null
  return (
    <div className="bg-card rounded-3xl p-6 border border-white/5">
      <h3 className="text-lg font-bold text-white mb-3">{title}</h3>
      <ul className="space-y-2">
        {sentences.map((s) => (
          <li key={s.key} className="text-sm text-muted leading-relaxed money">
            {s.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
