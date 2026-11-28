import { useState } from 'react'
import { toast } from '../../lib/toast'
import { decideTarget } from './api'
import Panel from '../ui/Panel'
import Button from '../ui/Button'

/**
 * The 14-day target review (Diet module, Phase 4). src/lib/diet/target.js
 * decides when it is due and what it proposes: maintenance from the latest
 * weigh-in (Mifflin-St Jeor, activity factor from Diet settings), the gap
 * below maintenance kept, never under 1,800 kcal. Nothing changes until the
 * owner taps Accept; "Keep" records the review so the next is in 14 days.
 */
export default function TargetReviewCard({ review, current, onDecided }) {
  const [busy, setBusy] = useState(false)
  if (!review) return null
  const p = review.proposal

  const decide = async (accept) => {
    setBusy(true)
    try {
      await decideTarget(p, accept)
      toast.success(accept ? `Target set to ${p.kcal_target.toLocaleString()} kcal` : 'Target kept')
      onDecided?.()
    } catch (err) {
      toast.error('Not saved: ' + err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel label="14-day target review">
      <div className="space-y-3">
        {review.change ? (
          <p className="text-body text-foreground">
            At {p.weight_kg} kg your maintenance is about {p.maintenance.toLocaleString()} kcal. Keeping the same gap, the new target would be{' '}
            <b className="font-semibold">{p.kcal_target.toLocaleString()} kcal</b> (now {current.toLocaleString()}).
          </p>
        ) : (
          <p className="text-body text-foreground">
            At {p.weight_kg} kg your target stays at <b className="font-semibold">{current.toLocaleString()} kcal</b>.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          {review.change ? (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => decide(false)}>
                Keep {current.toLocaleString()}
              </Button>
              <Button disabled={busy} onClick={() => decide(true)}>
                Accept
              </Button>
            </>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => decide(false)} className="col-span-2">
              OK
            </Button>
          )}
        </div>
        <p className="text-body-sm text-muted-dim">Exercise is never added back to the daily budget. The target never goes under 1,800 kcal.</p>
      </div>
    </Panel>
  )
}
