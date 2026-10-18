import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { hasColumn } from '../../lib/schema'
import { toast } from '../../lib/toast'
import { toDateOnly } from '../../lib/queries'
import { isMissingFunctionError } from '../../lib/corrections'
import { describeDiscovered, suggestWalletType } from '../../lib/discovery'

const WORD = { new: 'Waiting for you', tracking: 'Tracked', ignored: 'Ignored' }
const DOT = { new: 'bg-orange-400', tracking: 'bg-accent', ignored: 'bg-white/20' }

/**
 * Every account the audit has ever noticed in the mail, with its status
 * and the last balance it stated, and the controls to change your mind:
 * an ignored account can be tracked later, a tracked one shows which
 * wallet it became. The Daily HQ card asks the question; this is the
 * record. Self-contained like CategoryRules.
 */
export default function DiscoveredAccountsSettings() {
  const available = hasColumn('discovered_accounts.status')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(null)
  const today = toDateOnly(new Date())

  const load = useCallback(async () => {
    if (!available) {
      setLoading(false)
      return
    }
    const { data, error } = await supabase
      .from('discovered_accounts')
      .select('id, slug, sender, label, system, status, last_balance, last_seen_on, first_seen_at, times_seen, wallet_id, decided_at')
      .order('status', { ascending: true })
      .order('last_seen_on', { ascending: false })
    if (error) toast.error('Could not load discovered accounts: ' + error.message)
    setRows(error ? [] : data || [])
    setLoading(false)
  }, [available])

  useEffect(() => {
    load()
  }, [load])

  const setStatus = async (row, status) => {
    setBusy(row.id)
    const { error } = await supabase
      .from('discovered_accounts')
      .update({ status, decided_at: status === 'new' ? null : new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.id)
    setBusy(null)
    if (error) {
      toast.error('Could not update: ' + error.message)
      return
    }
    load()
  }

  const track = async (row) => {
    setBusy(row.id)
    try {
      const { error } = await supabase.rpc('adopt_discovered_account', {
        p_id: row.id,
        p_name: row.label || row.slug,
        p_type: suggestWalletType(row.slug),
      })
      if (error) {
        if (isMissingFunctionError(error)) throw new Error('run supabase/migrations/043_discovered_accounts.sql first')
        throw error
      }
      toast.success(`${row.label || row.slug} is now a wallet ✓ Rename it under Banks & Wallets if you like.`)
      load()
    } catch (err) {
      toast.error('Could not track it: ' + (err.message || 'check connection'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section id="discovered" className="bg-card rounded-3xl p-6 border border-white/10 space-y-4 scroll-mt-20">
      <div className="border-b border-white/5 pb-3">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">Accounts found in mail</h2>
        <p className="text-xs text-muted mt-2 leading-relaxed">
          Every bank, fintech or savings app the morning audit has seen alerts from without a wallet for it, with the
          last balance the mail stated. Track one and its alerts land in the ledger from the next run; ignore one and you
          are not asked again. Nothing here is counted anywhere until you track it.
        </p>
      </div>

      {!available ? (
        <div className="rounded-xl bg-orange-500/10 border border-orange-500/20 p-4 text-xs text-orange-300 leading-relaxed">
          Run <code className="font-mono">supabase/migrations/043_discovered_accounts.sql</code> in the Supabase SQL editor, then
          paste the updated prompt from <code className="font-mono">docs/routine-prompt.md</code> into the daily audit.
        </div>
      ) : loading ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted">Nothing yet. The audit adds a row the first time it sees an account it does not track.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-3 p-3 rounded-2xl bg-background/40 border border-white/5">
              <div className="flex items-start gap-2.5 min-w-0">
                <span className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${DOT[row.status] || DOT.new}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white truncate">{describeDiscovered(row, today)}</p>
                  <p className="text-[11px] text-muted truncate">
                    {WORD[row.status] || row.status}
                    {row.sender ? ` · ${row.sender}` : ''}
                    {row.system && row.system !== 'gmail' ? ` · via ${row.system}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                {row.status !== 'tracking' && (
                  <button
                    type="button"
                    onClick={() => track(row)}
                    disabled={busy === row.id}
                    className="px-3 rounded-xl bg-accent/15 text-accent text-xs font-bold min-h-[44px] disabled:opacity-50"
                  >
                    Track
                  </button>
                )}
                {row.status === 'new' && (
                  <button
                    type="button"
                    onClick={() => setStatus(row, 'ignored')}
                    disabled={busy === row.id}
                    className="px-3 rounded-xl bg-white/5 border border-white/10 text-muted hover:text-white text-xs font-bold min-h-[44px] disabled:opacity-50"
                  >
                    Ignore
                  </button>
                )}
                {row.status === 'ignored' && (
                  <button
                    type="button"
                    onClick={() => setStatus(row, 'new')}
                    disabled={busy === row.id}
                    className="px-3 rounded-xl bg-white/5 border border-white/10 text-muted hover:text-white text-xs font-bold min-h-[44px] disabled:opacity-50"
                  >
                    Ask again
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
