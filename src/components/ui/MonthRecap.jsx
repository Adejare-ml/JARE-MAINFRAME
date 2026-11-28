import Panel from './Panel'

/**
 * The month in review, from src/lib/monthRecap.js -- sentences the page
 * computed, shown as they are. Renders nothing for a month with no rows.
 */
export default function MonthRecap({ sentences = [], title = 'Month in review' }) {
  if (!sentences || sentences.length === 0) return null
  return (
    <Panel label={title}>
      <ul className="space-y-2">
        {sentences.map((s) => (
          <li key={s.key} className="text-body-sm text-muted money whitespace-normal">
            {s.text}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
