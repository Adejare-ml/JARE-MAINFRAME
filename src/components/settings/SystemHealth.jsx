import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { hasColumn, pendingMigrations } from '../../lib/schema'
import { timeAgo, formatDate } from '../../lib/formatters'
import { STATUS, summarizeRuns, gmailCursorStatus, overallStatus } from '../../lib/health'

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

const DOT = {
  [STATUS.OK]: 'bg-accent',
  [STATUS.STALE]: 'bg-orange-400',
  [STATUS.FAILING]: 'bg-red-500',
  [STATUS.NEVER]: 'bg-white/20',
}

const WORD = {
  [STATUS.OK]: 'Running',
  [STATUS.STALE]: 'Quiet too long',
  [STATUS.FAILING]: 'Failing',
  [STATUS.NEVER]: 'Never run',
}

export default function SystemHealth() {
  const available = hasColumn('sync_runs.job')
  const [runs, setRuns] = useState([])
  const [runsError, setRunsError] = useState(null)
  const [integration, setIntegration] = useState(null)
  const [failures, setFailures] = useState({ count: 0, recent: [] })
  const [ask, setAsk] = useState('checking')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const [runsRes, intRes, countRes, recentRes] = await Promise.all([
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
        supabase.from('sync_failures').select('id', { count: 'exact', head: true }),
        supabase
          .from('sync_failures')
          .select('id, source, last_error, last_failed_at, attempts')
          .order('last_failed_at', { ascending: false })
          .limit(5),
      ])
      if (cancelled) return
      setRuns(runsRes.data || [])
      setRunsError(runsRes.error?.message || null)
      setIntegration(intRes.data || null)
      setFailures({ count: countRes.count || 0, recent: recentRes.data || [] })
      setLoading(false)
    }
    load()

    // GET is answered without a model call, so "reachable" means deployed --
    // the one fact about the Ask page nothing else in the app can check.
    supabase.functions
      .invoke('ask-question', { method: 'GET' })
      .then(({ data, error }) => {
        if (!cancelled) setAsk(!error && data?.ok ? 'reachable' : 'unreachable')
      })
      .catch(() => {
        if (!cancelled) setAsk('unreachable')
      })

    return () => {
      cancelled = true
    }
  }, [available])

  const jobs = summarizeRuns(runs)
  const overall = available ? overallStatus(jobs) : STATUS.NEVER
  const cursor = gmailCursorStatus(integration)
  const pending = pendingMigrations()

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
      <div className="flex items-center justify-between border-b border-white/5 pb-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">System</h2>
        {available && !loading && (
          <span className="flex items-center gap-2 text-xs font-semibold text-white">
            <span className={`w-2 h-2 rounded-full ${DOT[overall]}`} aria-hidden="true" />
            {WORD[overall]}
          </span>
        )}
      </div>

      {!available ? (
        <div className="rounded-xl bg-orange-500/10 border border-orange-500/20 p-4 text-xs text-orange-300 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/025_sync_runs.sql</code> in the Supabase SQL editor to see when
          each scheduled job last ran and whether it worked.
        </div>
      ) : runsError ? (
        <div className="rounded-xl bg-red-500/10 border border-red-500/20 p-4 text-xs text-red-300 leading-relaxed">
          Could not read the job log: {runsError}
        </div>
      ) : (
        <ul className="space-y-2.5" aria-label="Scheduled jobs">
          {jobs.map((job) => (
            <li key={job.id} className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <span className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${DOT[job.status]}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{job.label}</p>
                  {job.lastRun?.summary && (
                    <p className="text-[11px] text-muted-dim truncate">{job.lastRun.summary}</p>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <p
                  className={`text-xs font-semibold ${
                    job.status === STATUS.FAILING
                      ? 'text-red-400'
                      : job.status === STATUS.STALE
                        ? 'text-orange-300'
                        : 'text-muted'
                  }`}
                >
                  {WORD[job.status]}
                </p>
                {job.lastRun && <p className="text-[11px] text-muted-dim">{timeAgo(job.lastRun.finished_at)}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        <div className="rounded-xl bg-background/60 border border-white/5 p-3">
          <dt className="text-[11px] text-muted uppercase tracking-wider">Mailbox</dt>
          <dd className="text-sm text-white mt-1">
            {cursor.status === STATUS.NEVER ? (
              'Never checked'
            ) : (
              <>
                Checked {timeAgo(integration.last_checked)}
              </>
            )}
          </dd>
          {cursor.status === STATUS.STALE && (
            <dd className="text-[11px] text-orange-300 mt-1">Longer than a day since the sync looked -- see the job above.</dd>
          )}
        </div>

        <div className="rounded-xl bg-background/60 border border-white/5 p-3">
          <dt className="text-[11px] text-muted uppercase tracking-wider">Ask endpoint</dt>
          <dd className="text-sm text-white mt-1">
            {ask === 'checking' ? 'Checking…' : ask === 'reachable' ? 'Deployed and answering' : 'Not deployed'}
          </dd>
          {ask === 'unreachable' && (
            <dd className="text-[11px] text-muted-dim mt-1">
              <code className="font-mono">supabase functions deploy ask-question</code>, then set its OLLAMA_API_KEY secret.
            </dd>
          )}
        </div>

        <div className="rounded-xl bg-background/60 border border-white/5 p-3">
          <dt className="text-[11px] text-muted uppercase tracking-wider">Database</dt>
          <dd className="text-sm text-white mt-1">
            {pending.length === 0 ? 'Up to date' : `${pending.length} migration${pending.length === 1 ? '' : 's'} to run`}
          </dd>
          {pending.length > 0 && (
            <dd className="text-[11px] text-muted-dim mt-1 font-mono break-all">{pending.join(', ')}</dd>
          )}
        </div>

        <div className="rounded-xl bg-background/60 border border-white/5 p-3">
          <dt className="text-[11px] text-muted uppercase tracking-wider">Emails the retired sync gave up on</dt>
          <dd className="text-sm text-white mt-1">{loading ? '…' : failures.count}</dd>
          {failures.recent.length > 0 && (
            <dd className="mt-2 space-y-1">
              {failures.recent.map((f) => (
                <p key={f.id} className="text-[11px] text-muted-dim truncate">
                  <span className="text-muted">{f.source || 'unknown'}</span> · {f.last_error || 'no error recorded'}
                  {f.last_failed_at && <span> · {timeAgo(f.last_failed_at)}</span>}
                </p>
              ))}
            </dd>
          )}
        </div>
      </dl>
    </section>
  )
}
