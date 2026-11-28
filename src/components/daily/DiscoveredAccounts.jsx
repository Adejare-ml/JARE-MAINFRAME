import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { hasColumn } from '../../lib/schema'
import { toast } from '../../lib/toast'
import { toDateOnly } from '../../lib/queries'
import { isMissingFunctionError } from '../../lib/corrections'
import { useRealtimeRefresh } from '../../hooks/useRealtimeRefresh'
import { awaitingDecision, describeDiscovered, suggestWalletType, DISCOVERY_URL } from '../../lib/discovery'
import Panel from '../ui/Panel'
import Button from '../ui/Button'
import { controlClasses } from '../ui/Field'

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
      toast.success(`${name.trim() || row.label || row.slug} is now a wallet. The next alert lands in the ledger.`)
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
    toast.success(`${row.label || row.slug} ignored. Change your mind in Settings, Accounts found in mail.`)
    load()
  }

  return (
    <Panel
      label="Found in your mail"
      meta={`${pending.length} new`}
      action={!compact && <Button size="sm" variant="ghost" to={DISCOVERY_URL}>All</Button>}
      flush
    >
      <p className="px-3 py-2.5 text-body-sm text-muted border-b border-border">
        The morning audit saw alerts from {pending.length === 1 ? 'an account' : `${pending.length} accounts`} it does not
        track. Nothing from {pending.length === 1 ? 'it' : 'them'} is in the ledger until you say so.
      </p>
      <ul className="divide-y divide-border">
        {pending.map((row) => (
          <li key={row.id} className="px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body text-foreground truncate">{row.label || row.slug}</p>
                <p className="text-body-sm text-muted truncate">{describeDiscovered(row, today)}</p>
                {row.sender && <p className="type-data text-muted-dim truncate">{row.sender}</p>}
              </div>
              {choosing !== row.id && (
                <div className="flex gap-2 shrink-0">
                  <Button size="sm" onClick={() => startTrack(row)} disabled={busy === row.id}>
                    Track
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => ignore(row)} disabled={busy === row.id}>
                    Ignore
                  </Button>
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
                  className={controlClasses()}
                />
                <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Wallet type" className={`${controlClasses()} capitalize`}>
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <Button type="submit" loading={busy === row.id} full>
                    Create wallet
                  </Button>
                  <Button variant="secondary" onClick={() => setChoosing(null)}>
                    Back
                  </Button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  )
}
