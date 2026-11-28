import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { hasColumn } from '../../lib/schema'
import { toast } from '../../lib/toast'
import { toDateOnly } from '../../lib/queries'
import { isMissingFunctionError } from '../../lib/corrections'
import { describeDiscovered, suggestWalletType } from '../../lib/discovery'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Button from '../ui/Button'
import StatusDot from '../ui/StatusDot'
import { Notice, Code } from './parts'

const WORD = { new: 'Waiting for you', tracking: 'Tracked', ignored: 'Ignored' }
const DOT = { new: 'warn', tracking: 'accent', ignored: 'never' }

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
      toast.success(`${row.label || row.slug} is now a wallet. Rename it under Banks & Wallets if you like.`)
      load()
    } catch (err) {
      toast.error('Could not track it: ' + (err.message || 'check connection'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Panel id="discovered" label="Accounts found in mail" className="scroll-mt-16" flush>
      <div className="p-3 lg:p-4 space-y-3">
        <p className="text-body-sm text-muted">
          Every bank, fintech or savings app the morning audit has seen alerts from without a wallet for it, with the
          last balance the mail stated. Track one and its alerts land in the ledger from the next run; ignore one and you
          are not asked again. Nothing here is counted anywhere until you track it.
        </p>
        {!available ? (
          <Notice>
            Run <Code>supabase/migrations/043_discovered_accounts.sql</Code> in the Supabase SQL editor, then paste the
            updated prompt from <Code>docs/routine-prompt.md</Code> into the daily audit.
          </Notice>
        ) : loading ? (
          <p className="text-body-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-body-sm text-muted">Nothing yet. The audit adds a row the first time it sees an account it does not track.</p>
        ) : null}
      </div>

      {available && !loading && rows.length > 0 && (
        <div className="border-t border-border">
          <ListRows as="ul" label="Accounts found in mail">
            {rows.map((row) => (
              <ListRow
                key={row.id}
                as="li"
                leading={<StatusDot status={DOT[row.status] || DOT.new} />}
                title={describeDiscovered(row, today)}
                subtitle={`${WORD[row.status] || row.status}${row.sender ? ` · ${row.sender}` : ''}${
                  row.system && row.system !== 'gmail' ? ` · via ${row.system}` : ''
                }`}
                trailing={
                  <>
                    {row.status !== 'tracking' && (
                      <Button size="sm" onClick={() => track(row)} disabled={busy === row.id}>
                        Track
                      </Button>
                    )}
                    {row.status === 'new' && (
                      <Button size="sm" variant="secondary" onClick={() => setStatus(row, 'ignored')} disabled={busy === row.id}>
                        Ignore
                      </Button>
                    )}
                    {row.status === 'ignored' && (
                      <Button size="sm" variant="secondary" onClick={() => setStatus(row, 'new')} disabled={busy === row.id}>
                        Ask again
                      </Button>
                    )}
                  </>
                }
              />
            ))}
          </ListRows>
        </div>
      )}
    </Panel>
  )
}
