import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { connectGmail, disconnectGmail, syncGmailEmails } from '../lib/gmailSync'
import { timeAgo, formatNaira } from '../lib/formatters'
import { toast } from '../lib/toast'
import { useAuth } from '../hooks/useAuth'

export default function Settings() {
  const { signOut } = useAuth()

  const [gmailStatus, setGmailStatus] = useState('disconnected') // 'connected' | 'disconnected'
  const [lastSync, setLastSync] = useState(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  // Wallets & Threshold State
  const [wallets, setWallets] = useState([])
  const [threshold, setThreshold] = useState('10000')
  const [savingThreshold, setSavingThreshold] = useState(false)

  // Account State
  const [userEmail, setUserEmail] = useState('')

  const loadData = async () => {
    try {
      setIsLoading(true)

      // 1. Fetch User Email
      const { data: { user } } = await supabase.auth.getUser()
      if (user?.email) {
        setUserEmail(user.email)
      }

      // 2. Fetch Gmail Integration
      const { data: intData, error: intErr } = await supabase
        .from('integrations')
        .select('*')
        .eq('service', 'gmail')
        .maybeSingle()

      if (intErr && intErr.code !== 'PGRST116') {
        console.error('Error loading integration:', intErr)
      }

      if (intData && (intData.status === 'connected' || intData.status === 'active')) {
        setGmailStatus('connected')
        setLastSync(intData.last_sync)
      } else {
        setGmailStatus('disconnected')
        setLastSync(null)
      }

      // 3. Fetch Wallets
      const { data: wData } = await supabase.from('wallets').select('*').order('created_at', { ascending: true })
      setWallets(wData || [])

      // 4. Fetch Low Balance Threshold from user_settings table
      const { data: setObj, error: setErr } = await supabase
        .from('user_settings')
        .select('*')
        .eq('key', 'low_balance_threshold')
        .maybeSingle()

      if (setErr && setErr.code !== 'PGRST116') {
        console.error('Error fetching settings:', setErr)
      }

      if (setObj && setObj.value) {
        setThreshold(setObj.value)
      }
    } catch (err) {
      console.error('Error loading Settings data:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  const handleConnect = async () => {
    setIsConnecting(true)
    const result = await connectGmail((updatedData) => {
      // Immediate UI update callback
      setGmailStatus('connected')
      if (updatedData?.last_sync) {
        setLastSync(updatedData.last_sync)
      }
    })

    if (result?.success) {
      setGmailStatus('connected')
      loadData()
    }
    setIsConnecting(false)
  }

  const handleDisconnect = async () => {
    const success = await disconnectGmail()
    if (success) {
      setGmailStatus('disconnected')
      setLastSync(null)
    }
  }

  const handleSync = async () => {
    setIsSyncing(true)
    await syncGmailEmails()
    await loadData()
    setIsSyncing(false)
  }

  const handleSaveThreshold = async (e) => {
    e.preventDefault()
    const num = parseFloat(threshold)
    if (isNaN(num) || num < 0) {
      toast.error('Please enter a valid threshold amount')
      return
    }

    setSavingThreshold(true)
    try {
      const now = new Date().toISOString()
      
      const { data: existing } = await supabase
        .from('user_settings')
        .select('*')
        .eq('key', 'low_balance_threshold')
        .maybeSingle()

      if (existing) {
        const { error } = await supabase
          .from('user_settings')
          .update({ value: String(num), updated_at: now })
          .eq('id', existing.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('user_settings')
          .insert({ key: 'low_balance_threshold', value: String(num), updated_at: now })
        if (error) throw error
      }

      toast.success('Threshold saved ✓')
    } catch (err) {
      console.error('Error saving threshold:', err)
      toast.error('Failed to save threshold: ' + (err.message || 'Check connection'))
    } finally {
      setSavingThreshold(false)
    }
  }

  const isConnected = gmailStatus === 'connected'

  return (
    <div className="space-y-6 pb-8 max-w-2xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-extrabold text-white">Settings</h1>
        <p className="text-muted text-sm mt-0.5">Manage integrations, wallets, and account</p>
      </div>

      {isLoading ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-40 bg-card rounded-3xl border border-white/5" />
          <div className="h-40 bg-card rounded-3xl border border-white/5" />
          <div className="h-28 bg-card rounded-3xl border border-white/5" />
        </div>
      ) : (
        <div className="space-y-6">

          {/* EMAIL SYNC SECTION */}
          <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-5">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">
              Email Sync
            </h2>

            {/* Gmail Connection Card */}
            <div className="bg-background/50 border border-white/5 rounded-2xl p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">📧</span>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-white text-base">Gmail</h3>
                      {isConnected ? (
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-accent/20 text-accent border border-accent/30 flex items-center gap-1">
                          <span>✓</span> Connected
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/5 text-muted border border-white/10 uppercase">
                          Not Connected
                        </span>
                      )}
                    </div>
                    {isConnected && lastSync && (
                      <p className="text-xs text-muted mt-1">
                        Last sync: {timeAgo(lastSync)}
                      </p>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto pt-2 sm:pt-0">
                  {isConnected ? (
                    <>
                      <button
                        onClick={handleSync}
                        disabled={isSyncing}
                        className="w-full sm:w-auto px-5 py-3 bg-accent hover:bg-accent/90 text-black font-bold rounded-xl transition-all min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-50 text-sm"
                      >
                        {isSyncing ? (
                          <>
                            <span className="animate-spin text-base">⌛</span>
                            <span>Syncing...</span>
                          </>
                        ) : (
                          'Sync Now'
                        )}
                      </button>
                      <button
                        onClick={handleDisconnect}
                        className="w-full sm:w-auto px-4 py-3 bg-white/5 hover:bg-red-500/10 text-muted hover:text-red-400 border border-white/5 rounded-xl transition-all min-h-[48px] text-xs font-bold"
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={handleConnect}
                      disabled={isConnecting}
                      className="w-full sm:w-auto px-6 py-3 bg-accent hover:bg-accent/90 text-black font-bold text-sm rounded-xl transition-all min-h-[48px] flex items-center justify-center gap-2 shadow-lg shadow-accent/20 disabled:opacity-50"
                    >
                      {isConnecting ? 'Connecting...' : 'Connect Gmail'}
                    </button>
                  )}
                </div>
              </div>

              {/* Auto-synced Senders */}
              <div className="pt-3 border-t border-white/5">
                <p className="text-xs text-muted font-semibold mb-2">Auto-synced senders:</p>
                <ul className="text-xs text-muted/80 space-y-1 font-mono pl-2">
                  <li className="flex items-center gap-2">
                    <span className="text-accent">•</span>
                    <span>alerts@gtbank.com</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <span className="text-accent">•</span>
                    <span>customerservice@opay-inc.com</span>
                  </li>
                </ul>
              </div>
            </div>
          </section>

          {/* WALLETS SECTION */}
          <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-5">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">
              Wallets Configuration
            </h2>

            {/* Wallet Balances Preview */}
            <div className="space-y-2">
              <p className="text-xs text-muted font-semibold">Active Wallets:</p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {wallets.map(w => {
                  const icon = w.type === 'bank' ? '🏦' : w.type === 'mobile' ? '📱' : '💵'
                  return (
                    <div key={w.id} className="p-3 bg-background/50 rounded-2xl border border-white/5">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-base">{icon}</span>
                        <span className="text-xs font-bold text-white">{w.name}</span>
                      </div>
                      <p className="text-sm font-extrabold text-white">{formatNaira(w.balance)}</p>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Threshold Setting Form */}
            <form onSubmit={handleSaveThreshold} className="space-y-3 pt-2">
              <label className="block text-xs text-muted font-semibold">
                Low Balance Warning Threshold (₦)
              </label>
              <p className="text-[11px] text-muted/70">
                Wallets below this amount trigger warnings on Daily HQ
              </p>
              
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted font-bold">₦</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    placeholder="10000"
                    required
                    className="w-full pl-9 pr-4 py-3 bg-background border border-white/10 rounded-xl text-white font-bold text-sm placeholder-muted/40 focus:outline-none focus:border-accent min-h-[48px]"
                  />
                </div>

                <button
                  type="submit"
                  disabled={savingThreshold}
                  className="px-6 py-3 bg-white/10 hover:bg-accent text-white hover:text-black font-bold text-sm rounded-xl transition-all min-h-[48px] disabled:opacity-50"
                >
                  {savingThreshold ? 'Saving...' : 'Save Threshold'}
                </button>
              </div>
            </form>
          </section>

          {/* ACCOUNT SECTION */}
          <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
            <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">
              Account
            </h2>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <p className="text-xs text-muted mb-0.5">Logged in as</p>
                <p className="text-sm font-bold text-white font-mono">{userEmail || 'Adejare Adelugba'}</p>
              </div>

              <button
                onClick={signOut}
                className="w-full sm:w-auto px-6 py-3 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-bold text-sm rounded-xl transition-all min-h-[48px]"
              >
                Log Out 🚪
              </button>
            </div>
          </section>

        </div>
      )}
    </div>
  )
}
