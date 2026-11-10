import { useState } from 'react'
import { toast } from '../../lib/toast'
import { decideTarget } from './api'

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
      toast.success(accept ? `Target set to ${p.kcal_target.toLocaleString()} kcal ✓` : 'Target kept ✓')
      onDecided?.()
    } catch (err) {
      toast.error('Not saved: ' + err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-3xl p-5 border border-accent/30 bg-accent/5 space-y-3" aria-label="Target review">
      <p className="text-xs font-semibold text-muted uppercase tracking-wider">14-day target review</p>
      {review.change ? (
        <p className="text-sm text-white leading-relaxed">
          At {p.weight_kg} kg your maintenance is about {p.maintenance.toLocaleString()} kcal. Keeping the same gap, the new target would be{' '}
          <b>{p.kcal_target.toLocaleString()} kcal</b> (now {current.toLocaleString()}).
        </p>
      ) : (
        <p className="text-sm text-white leading-relaxed">
          At {p.weight_kg} kg your target stays at <b>{current.toLocaleString()} kcal</b>.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {review.change ? (
          <>
            <button type="button" disabled={busy} onClick={() => decide(false)} className="min-h-[48px] rounded-xl bg-white/5 text-white text-sm font-bold disabled:opacity-60">
              Keep {current.toLocaleString()}
            </button>
            <button type="button" disabled={busy} onClick={() => decide(true)} className="min-h-[48px] rounded-xl bg-accent text-black text-sm font-extrabold disabled:opacity-60">
              Accept
            </button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => decide(false)} className="col-span-2 min-h-[48px] rounded-xl bg-white/5 text-white text-sm font-bold disabled:opacity-60">
            OK
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted-dim">Exercise is never added back to the daily budget. The target never goes under 1,800 kcal.</p>
    </section>
  )
}
