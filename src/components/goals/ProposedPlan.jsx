import { formatDate } from '../../lib/formatters'

/**
 * The month a model proposed, waiting for you to say yes.
 *
 * This is the only screen in the app that shows a draft, and the only place the
 * planner's output can become real. Everywhere else filters drafts out, which
 * is what makes "drafted, not applied" a property of the system rather than a
 * promise about a script.
 *
 * Two things it insists on, both because of what this output is:
 *
 *   It shows the citation. Every item names the path or the gap it was derived
 *   from, because the rule the planner enforces -- suggest nothing you cannot
 *   ground -- is worth nothing if the grounding is invisible at the moment you
 *   decide. Approving a plan you cannot check is approving a plan you are
 *   trusting, and trusting is what this was built to avoid.
 *
 *   Discard is as easy as approve. Not a confirmation, not buried: the two are
 *   the same size, side by side. A proposal that is awkward to refuse is a
 *   proposal you will accept out of friction, and then the drafts were
 *   decoration.
 */
export default function ProposedPlan({ drafts, onApprove, onDiscard, busy }) {
  if (!drafts || drafts.length === 0) return null

  const planned = drafts.find((d) => d.planned_at)?.planned_at
  const model = drafts.find((d) => d.plan_evidence?.model)?.plan_evidence?.model

  return (
    <section className="bg-card rounded-3xl p-6 border border-accent/30 space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold text-white">Proposed plan</h2>
          <span className="text-[10px] uppercase tracking-wider text-black bg-accent rounded-full px-2 py-0.5 font-bold">
            draft
          </span>
        </div>
        <p className="text-xs text-muted mt-1">
          {drafts.length} week{drafts.length === 1 ? '' : 's'} suggested
          {planned && ` on ${formatDate(String(planned).slice(0, 10))}`}
          {model && ` by ${model}`}. Nothing derives from these until you approve them.
        </p>
      </div>

      <ul className="space-y-2">
        {drafts.map((draft) => (
          <li
            key={draft.id}
            className="bg-background/50 border border-white/5 rounded-2xl p-4 space-y-1.5"
          >
            <p className="text-sm text-white">{draft.focus || draft.title}</p>

            <p className="text-[11px] text-muted">
              Week of {formatDate(draft.target_date)}
            </p>

            {/* What it was derived from. Without this the plan is just a
                sentence that sounds right, which is the failure mode the whole
                citation rule exists to catch. */}
            {draft.plan_evidence?.cites && (
              <p className="text-[10px] text-muted-dim">
                <span className="text-muted">
                  {draft.plan_evidence.kind === 'gap' ? 'From a gap you logged: ' : 'From: '}
                </span>
                <span className="font-mono">{draft.plan_evidence.cites}</span>
              </p>
            )}

            {draft.plan_evidence?.reason && (
              <p className="text-[11px] text-muted italic">{draft.plan_evidence.reason}</p>
            )}
          </li>
        ))}
      </ul>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={busy}
          className="flex-1 py-3 bg-accent text-black font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy}
          className="flex-1 py-3 bg-white/5 border border-white/10 text-muted hover:text-white font-bold text-sm rounded-xl min-h-[48px] disabled:opacity-50"
        >
          Discard
        </button>
      </div>

      <p className="text-[10px] text-muted-dim">
        Approving keeps the words. The numbers stay yours — how much each week asks for
        is still worked out from the goal, not from this.
      </p>
    </section>
  )
}
