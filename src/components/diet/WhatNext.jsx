import { useState } from 'react'
import { askWhatNext } from './api'
import Panel from '../ui/Panel'
import Button from '../ui/Button'
import Badge from '../ui/Badge'
import ListRow, { ListRows } from '../ui/ListRow'

/**
 * "What should I eat next?" (Diet module, Phase 4). Sends what is left of
 * today, the time, the last 7 days and the pantry to the coach (diet-coach,
 * prompts/coach.md) and shows two or three options, pantry food first.
 * The options have already been checked (src/lib/diet/coach.js): nothing
 * with a food the owner avoids, nothing that skips a meal.
 */
export default function WhatNext() {
  const [state, setState] = useState({ busy: false, result: null, error: null })

  const ask = async () => {
    setState({ busy: true, result: null, error: null })
    const res = await askWhatNext()
    setState({ busy: false, result: res.ok ? res : null, error: res.ok ? null : res.reason })
  }

  return (
    <Panel label="What to eat next" meta={state.result ? `${state.result.next_options.length} option${state.result.next_options.length === 1 ? '' : 's'}` : undefined} flush={Boolean(state.result?.next_options.length)}>
      <div className={state.result?.next_options.length ? 'p-3 lg:p-4 space-y-3' : 'space-y-3'}>
        <Button variant="secondary" full onClick={ask} loading={state.busy}>
          {state.busy ? 'Asking the coach…' : 'What should I eat next?'}
        </Button>
        {state.error && (
          <p className="text-body-sm text-warn" role="alert">
            {state.error}
          </p>
        )}
        {state.result?.reason && <p className="text-body text-foreground">{state.result.reason}</p>}
        {state.result && state.result.next_options.length === 0 && <p className="text-body-sm text-muted">No suggestion passed the checks. Try again in a moment.</p>}
        {state.result?.flag && <p className="text-body-sm text-warn">{state.result.flag}</p>}
      </div>
      {state.result?.next_options.length > 0 && (
        <div aria-live="polite" className="border-t border-border">
          <ListRows as="ul">
            {state.result.next_options.map((o, i) => (
              <ListRow
                key={i}
                as="li"
                wrap
                title={o.meal}
                subtitle={`${o.kcal.toLocaleString()} kcal · ${o.protein_g} g protein${o.why ? ` · ${o.why}` : ''}`}
                trailing={o.from_pantry ? <Badge label="at home" tone="accent" /> : null}
              />
            ))}
          </ListRows>
        </div>
      )}
    </Panel>
  )
}
