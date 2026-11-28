import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { hasColumn, pendingMigrations } from '../../lib/schema'
import { timeAgo } from '../../lib/formatters'
import { STATUS, summarizeRuns, gmailCursorStatus, overallStatus, jobTitle } from '../../lib/health'
import { useEdgeFunctionStatus } from '../../hooks/useEdgeFunctionStatus'
import Panel from '../ui/Panel'
import StatusDot from '../ui/StatusDot'
import Label from '../ui/Label'
import { Notice, Code } from './parts'

/**
 * The one place the app admits whether its automation is alive.
 *
 * For five weeks every scheduled job failed on its first line and nothing
 * on screen said so: the failure issues went to GitHub, the app kept its
 * usual shape. This reads sync_runs (migration 025) plus the two signals
 * that already existed but were never surfaced together -- the Gmail
 * cursor and the emails the sync gave up on -- and asks the Ask endpoint
 * whether it is deployed at all.
 *
 * Self-contained like CategoryRules: its own fetches, so Settings' central
 * load does not grow four more queries for one section.
 */

const WORD = {
  [STATUS.OK]: 'OK',
  [STATUS.STALE]: 'Quiet too long',
  [STATUS.FAILING]: 'Failing',
  [STATUS.NEVER]: 'Never run',
  [STATUS.ATTENTION]: 'Needs a look',
}

const WORD_COLOUR = {
  [STATUS.FAILING]: 'text-danger',
  [STATUS.STALE]: 'text-warn',
  [STATUS.ATTENTION]: 'text-warn',
}

/** One fact under the job list: a label, its value, an optional how-to. */
function Fact({ label, value, note, tone }) {
  return (
    <div className="px-3 py-2.5 lg:px-4">
      <dt>
        <Label>{label}</Label>
      </dt>
      <dd className="text-body text-foreground mt-0.5">{value}</dd>
      {note && <dd className={`text-body-sm mt-0.5 break-words ${tone === 'warn' ? 'text-warn' : 'text-muted'}`}>{note}</dd>}
    </div>
  )
}

export default function SystemHealth() {
  const available = hasColumn('sync_runs.job')
  const [runs, setRuns] = useState([])
  const [runsError, setRunsError] = useState(null)
  const [integration, setIntegration] = useState(null)
  // The two edge-function probes, shared with Daily HQ's setup checklist.
  const { ask, meal } = useEdgeFunctionStatus()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [runsRes, intRes] = await Promise.all([
        available
          ? supabase
              .from('sync_runs')
              .select('job, finished_at, ok, summary')
              .order('finished_at', { ascending: false })
              // A window, not a row count: sixty rows reach back about two
              // weeks once four jobs write daily, and the month plan fell out
              // of view mid-month and read "Never run".
              .gte('finished_at', new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString())
          : Promise.resolve({ data: [] }),
        supabase.from('integrations').select('last_checked, last_sync').eq('service', 'gmail').maybeSingle(),
      ])
      if (cancelled) return
      setRuns(runsRes.data || [])
      setRunsError(runsRes.error?.message || null)
      setIntegration(intRes.data || null)
      setLoading(false)
    }
    load()

    return () => {
      cancelled = true
    }
  }, [available])

  const jobs = summarizeRuns(runs)
  const overall = available ? overallStatus(jobs) : STATUS.NEVER
  const cursor = gmailCursorStatus(integration)
  const pending = pendingMigrations()

  return (
    // id="system": the status rail and Daily HQ link to /settings#system,
    // and Settings scrolls here when the hash is present.
    <Panel
      id="system"
      label="System"
      className="scroll-mt-16"
      meta={
        available && !loading ? (
          <span className="flex items-center gap-2">
            <StatusDot status={overall} />
            {WORD[overall]}
          </span>
        ) : null
      }
      flush
    >
      {!available ? (
        <div className="p-3 lg:p-4">
          <Notice>
            Run <Code>supabase/migrations/025_sync_runs.sql</Code> in the Supabase SQL editor to see when each scheduled
            job last ran and whether it worked.
          </Notice>
        </div>
      ) : runsError ? (
        <div className="p-3 lg:p-4">
          <Notice status="danger">Could not read the job log: {runsError}</Notice>
        </div>
      ) : (
        <ul className="divide-y divide-border" aria-label="Scheduled jobs">
          {jobs.map((job) => (
            <li key={job.id} className="flex items-start gap-3 px-3 py-2.5 lg:px-4 min-h-14">
              <StatusDot status={job.suspect ? STATUS.FAILING : job.status} className="mt-2" />
              <div className="min-w-0 flex-1">
                <p className="text-body text-foreground">{jobTitle(job)}</p>
                {/* A report is rendered line by line, drifts red and
                    missed alerts amber, so a reconcile summary is read,
                    not skimmed. Anything else is the stored text in
                    full: the one-line truncation used to cut the gap
                    list exactly where the wallet names were. */}
                {job.suspect && <p className="text-body-sm text-danger break-words">{job.suspectReason}</p>}
                {job.report ? (
                  <>
                    {job.report.drifts.map((line) => (
                      <p key={line} className="text-body-sm text-danger break-words">{line}</p>
                    ))}
                    {job.report.gaps.map((line) => (
                      <p key={line} className="text-body-sm text-warn break-words">{line}</p>
                    ))}
                    {job.report.other.map((line) => (
                      <p key={line} className="text-body-sm text-muted break-words">{line}</p>
                    ))}
                  </>
                ) : (
                  job.lastRun?.summary && (
                    <p className="text-body-sm text-muted break-words whitespace-pre-wrap">{job.lastRun.summary}</p>
                  )
                )}
              </div>
              <div className="text-right shrink-0">
                <p className={`text-body-sm font-semibold ${job.suspect ? 'text-danger' : WORD_COLOUR[job.status] || 'text-muted'}`}>
                  {job.suspect ? 'Recorded nothing' : WORD[job.status]}
                </p>
                {job.lastRun && <p className="type-data text-muted-dim">{timeAgo(job.lastRun.finished_at)}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 border-t border-border divide-y divide-border sm:divide-y-0">
        <Fact
          label="Bank alerts last recorded"
          value={cursor.status === STATUS.NEVER ? 'Never checked' : `Checked ${timeAgo(integration.last_checked)}`}
          note={cursor.status === STATUS.STALE ? 'Longer than a day since the audit recorded anything. See the audit above.' : null}
          tone="warn"
        />
        <Fact
          label="Ask endpoint"
          value={ask === 'checking' ? 'Checking…' : ask === 'reachable' ? 'Deployed and answering' : 'Not deployed'}
          note={
            ask === 'unreachable' ? (
              <>
                <Code>supabase functions deploy ask-question</Code>, then set its OLLAMA_API_KEY secret.
              </>
            ) : null
          }
        />
        <Fact
          label="Meal photo reader"
          value={
            meal === 'checking'
              ? 'Checking…'
              : meal === 'reachable'
                ? 'Deployed and answering'
                : meal === 'nokey'
                  ? 'Deployed, no model key'
                  : 'Not deployed'
          }
          note={
            meal !== 'reachable' && meal !== 'checking' ? (
              <>
                <Code>supabase functions deploy analyze-meal</Code>, then set its OLLAMA_API_KEY (and optionally
                NVIDIA_API_KEY) secret.
              </>
            ) : null
          }
        />
        <Fact
          label="Database"
          value={pending.length === 0 ? 'Up to date' : `${pending.length} migration${pending.length === 1 ? '' : 's'} to run`}
          note={pending.length > 0 ? <Code>{pending.join(', ')}</Code> : null}
        />
      </dl>
    </Panel>
  )
}
