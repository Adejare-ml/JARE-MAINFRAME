import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { hasColumn } from '../../lib/schema'
import { toast } from '../../lib/toast'
import { toDateOnly } from '../../lib/queries'
import { isMissingFunctionError } from '../../lib/corrections'
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh'
import { awaitingDecision, describeDiscovered, suggestWalletType, DISCOVERY_URL } from '../../lib/discovery'

const TYPES = ['bank', 'mobile', 'savings', 'investment', 'cash']

/**
 * "The mail mentions an account you are not tracking. Track it?"
 *
 * The audit notes every bank, fintech or savings app it sees alerts from
 * and has no wallet for (migration 043). This asks the owner, in the one
 * place they look every morning, and takes the answer: Track creates a
 * wallet with that slug and sender (so the next alert lands in the ledger)
 * through adopt_discovered_account; Ignore mutes the row. Renders nothing
 * when there is nothing to decide, and a one-line notice behind 043.
 *
 * Self-contained like FoodToday: its own fetch and realtime refresh, so
 * Daily HQ's central load does not grow another query for one card.
 */
export default function DiscoveredAccounts({ compact = false }) {
  const available = hasColumn('discovered_accounts.status')
  const [rows, setRows] = useState([])
  const [busy, setBusy] = useState(null)
  const [choosing, setChoosing] = useState(null) // id being tracked, with name/type inputs
  const [name, setName] = useState('')
  const [type, setType] = useState('bank')
  const today = toDateOnly(new Date())

  const load = useCallback(async () => {
    if (!available) return
    const { data, error } = await supabase
      .from('discovered_accounts')
      .select('id, slug, sender, label, status, last_balance, last_seen_on, first_seen_at, times_seen')
      .eq('status', 'new')
      .order('first_seen_at', { ascending: true })
    if (!error) setRows(data || [])
  }, [available])

  useEffect(() => {
    load()
  }, [load])
  useRealtimeRefresh(['discovered_accounts'], load, { channelPrefix: 'discovered', enabled: available })

  if (!available || rows.length === 0) return null
  const pending = awaitingDecision(rows)

  const startTrack = (row) => {
    setChoosing(row.id)
    setName(row.label || row.slug)
    setType(suggestWalletType(row.slug))
  }

  const track = async (row) => {
    setBusy(row.id)
    try {
      const { data, error } = await supabase.rpc('adopt_discovered_account', {
        p_id: row.id,
        p_name: name.trim() || row.label || row.slug,
        p_type: type,
      })
      if (error) {
        if (isMissingFunctionError(error)) throw new Error('run supabase/migrations/043_discovered_accounts.sql first')
        throw error
      }
      toast.success(`${name.trim() || row.label || row.slug} is now a wallet ✓ The next alert lands in the ledger.`)
      setChoosing(null)
      load()
      return data
    } catch (err) {
      toast.error('Could not track it: ' + (err.message || 'check connection'))
    } finally {
      setBusy(null)
    }
  }

  const ignore = async (row) => {
    setBusy(row.id)
    const { error } = await supabase
      .from('discovered_accounts')
      .update({ status: 'ignored', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.id)
    setBusy(null)
    if (error) {
      toast.error('Could not ignore it: ' + error.message)
      return
    }
    toast.success(`${row.label || row.slug} ignored. Change your mind under Settings → Accounts found in mail.`)
    load()
  }

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold text-muted uppercase tracking-wider flex items-center gap-2">
          <span aria-hidden="true">📬</span> Found in your mail
        </h2>
        {!compact && (
          <Link to={DISCOVERY_URL} className="text-xs font-semibold text-accent hover:underline">
            All →
          </Link>
        )}
      </div>
      <p className="text-xs text-muted leading-relaxed">
        The morning audit saw alerts from {pending.length === 1 ? 'an account' : `${pending.length} accounts`} it does not
        track. Nothing from {pending.length === 1 ? 'it' : 'them'} is in the ledger until you say so.
      </p>
      <ul className="space-y-2">
        {pending.map((row) => (
          <li key={row.id} className="rounded-2xl bg-background/40 border border-white/5 p-3 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-white truncate">{row.label || row.slug}</p>
                <p className="text-[11px] text-muted truncate">{describeDiscovered(row, today)}</p>
                {row.sender && <p className="text-[10px] text-muted-dim truncate">{row.sender}</p>}
              </div>
              {choosing !== row.id && (
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => startTrack(row)}
                    disabled={busy === row.id}
                    className="px-3 rounded-xl bg-accent text-black text-xs font-extrabold min-h-[44px] disabled:opacity-50"
                  >
                    Track
                  </button>
                  <button
                    type="button"
                    onClick={() => ignore(row)}
                    disabled={busy === row.id}
                    className="px-3 rounded-xl bg-white/5 border border-white/10 text-muted hover:text-white text-xs font-bold min-h-[44px] disabled:opacity-50"
                  >
                    Ignore
                  </button>
                </div>
              )}
            </div>
            {choosing === row.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  track(row)
                }}
                className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2"
              >
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Wallet name"
                  maxLength={60}
                  className="min-w-0 px-3 py-2.5 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[44px]"
                />
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  aria-label="Wallet type"
                  className="px-3 py-2.5 bg-background border border-white/10 rounded-xl text-white text-sm min-h-[44px] capitalize"
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <button type="submit" disabled={busy === row.id} className="flex-1 px-3 rounded-xl bg-accent text-black text-xs font-extrabold min-h-[44px] disabled:opacity-50">
                    {busy === row.id ? 'Creating…' : 'Create wallet'}
                  </button>
                  <button type="button" onClick={() => setChoosing(null)} className="px-3 rounded-xl bg-white/5 text-muted text-xs font-bold min-h-[44px]">
                    Back
                  </button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
