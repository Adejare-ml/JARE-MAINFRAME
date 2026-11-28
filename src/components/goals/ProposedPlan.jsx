import { formatDate } from '../../lib/formatters'
import Panel from '../ui/Panel'
import Badge from '../ui/Badge'
import Button from '../ui/Button'

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
    <Panel label="Proposed plan" tone="warn" action={<Badge label="Draft" tone="warn" />} flush>
      <p className="px-3 pt-3 lg:px-4 text-body-sm text-muted">
        {drafts.length} week{drafts.length === 1 ? '' : 's'} suggested
        {planned && ` on ${formatDate(String(planned).slice(0, 10))}`}
        {model && ` by ${model}`}. Nothing derives from these until you approve them.
      </p>

      <ul className="mt-3 divide-y divide-border border-y border-border">
        {drafts.map((draft) => (
          <li key={draft.id} className="px-3 py-2.5 lg:px-4 space-y-0.5">
            <p className="text-body text-foreground">{draft.focus || draft.title}</p>
            <p className="type-data text-muted">Week of {formatDate(draft.target_date)}</p>

            {/* What it was derived from. Without this the plan is just a
                sentence that sounds right, which is the failure mode the whole
                citation rule exists to catch. */}
            {draft.plan_evidence?.cites && (
              <p className="text-body-sm text-muted-dim break-words">
                {draft.plan_evidence.kind === 'gap' ? 'From a gap you logged: ' : 'From: '}
                <span className="type-data">{draft.plan_evidence.cites}</span>
              </p>
            )}

            {draft.plan_evidence?.reason && (
              <p className="text-body-sm text-muted">{draft.plan_evidence.reason}</p>
            )}
          </li>
        ))}
      </ul>

      <div className="p-3 lg:p-4 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onApprove} loading={busy}>
            Approve
          </Button>
          <Button variant="secondary" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        </div>
        <p className="text-body-sm text-muted-dim">
          Approving keeps the words. The numbers stay yours: how much each week asks for
          is still worked out from the goal, not from this.
        </p>
      </div>
    </Panel>
  )
}
