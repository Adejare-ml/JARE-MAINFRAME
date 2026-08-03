import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { connectGmail, disconnectGmail, syncGmailEmails } from '../lib/gmailSync'
import { timeAgo, formatNaira } from '../lib/formatters'
import { toast } from '../lib/toast'
import { useAuth } from '../hooks/useAuth'

const WALLET_TYPES = [
  { value: 'bank', label: 'Bank', icon: '🏦' },
  { value: 'mobile', label: 'Mobile Money', icon: '📱' },
  { value: 'cash', label: 'Cash', icon: '💵' },
  { value: 'savings', label: 'Savings', icon: '🐖' },
  { value: 'investment', label: 'Investment', icon: '📈' },
]

const PRESET_COLORS = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

export default function Settings() {
  const { signOut } = useAuth()

  const [gmailStatus, setGmailStatus] = useState('disconnected')
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

  // Add/Edit Wallet Modal
  const [showWalletModal, setShowWalletModal] = useState(false)
  const [editingWallet, setEditingWallet] = useState(null)
  const [walletForm, setWalletForm] = useState({
    name: '',
    type: 'bank',
    balance: '',
    alert_sender: '',
    account_last4: '',
    color: '#22c55e',
    is_active: true,
  })
  const [savingWallet, setSavingWallet] = useState(false)

  // Delete confirm
  const [deletingWalletId, setDeletingWalletId] = useState(null)

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

  // ── Gmail Handlers ──

  const handleConnect = async () => {
    setIsConnecting(true)
    const result = await connectGmail((updatedData) => {
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

  // ── Threshold Handler ──

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

  // ── Wallet CRUD Handlers ──

  const openAddWallet = () => {
    setEditingWallet(null)
    setWalletForm({
      name: '',
      type: 'bank',
      balance: '',
      alert_sender: '',
      account_last4: '',
      color: '#22c55e',
      is_active: true,
    })
    setShowWalletModal(true)
  }

  const openEditWallet = (wallet) => {
    setEditingWallet(wallet)
    setWalletForm({
      name: wallet.name || '',
      type: wallet.type || 'bank',
      balance: String(wallet.balance || ''),
      alert_sender: wallet.alert_sender || '',
      account_last4: wallet.account_last4 || '',
      color: wallet.color || '#22c55e',
      is_active: wallet.is_active !== false,
    })
    setShowWalletModal(true)
  }

  const handleSaveWallet = async (e) => {
    e.preventDefault()
    if (!walletForm.name.trim()) {
      toast.error('Wallet name is required')
      return
    }

    setSavingWallet(true)
    try {
      const payload = {
        name: walletForm.name.trim(),
        type: walletForm.type,
        balance: parseFloat(walletForm.balance) || 0,
        currency: 'NGN',
        alert_sender: walletForm.alert_sender.trim() || null,
        account_last4: walletForm.account_last4.trim() || null,
        color: walletForm.color,
        is_active: walletForm.is_active,
      }

      if (editingWallet) {
        const { error } = await supabase
          .from('wallets')
          .update(payload)
          .eq('id', editingWallet.id)
        if (error) throw error
        toast.success('Wallet updated ✓')
      } else {
        const { error } = await supabase
          .from('wallets')
          .insert(payload)
        if (error) throw error
        toast.success('Wallet added ✓')
      }

      setShowWalletModal(false)
      await loadData()
    } catch (err) {
      console.error('Error saving wallet:', err)
      toast.error('Failed to save wallet: ' + (err.message || 'Unknown error'))
    } finally {
      setSavingWallet(false)
    }
  }

  const handleToggleActive = async (wallet) => {
    try {
      const { error } = await supabase
        .from('wallets')
        .update({ is_active: !wallet.is_active })
        .eq('id', wallet.id)
      if (error) throw error
      toast.success(wallet.is_active ? 'Wallet deactivated' : 'Wallet reactivated')
      await loadData()
    } catch (err) {
      toast.error('Failed to update wallet')
    }
  }

  const handleDeleteWallet = async (walletId) => {
    try {
      const { error } = await supabase
        .from('wallets')
        .delete()
        .eq('id', walletId)
      if (error) throw error
      toast.success('Wallet deleted')
      setDeletingWalletId(null)
      await loadData()
    } catch (err) {
      toast.error('Failed to delete wallet: ' + (err.message || 'Unknown error'))
    }
  }

  const isConnected = gmailStatus === 'connected'

  // Compute dynamic sender list for display
  const dynamicSenders = wallets
    .filter(w => w.alert_sender && w.is_active !== false)
    .map(w => ({ name: w.name, sender: w.alert_sender }))

  const defaultSenders = [
    { name: 'GTBank', sender: 'GeNS@gtbank.com' },
    { name: 'OPay', sender: 'no-reply@opay-nigeria.com' },
  ]

  // Merge: show wallet senders first, then add defaults if not already covered
  const allSenders = [...dynamicSenders]
  for (const ds of defaultSenders) {
    if (!allSenders.some(s => s.sender.toLowerCase() === ds.sender.toLowerCase())) {
      allSenders.push(ds)
    }
  }

  return (
    <div className="space-y-6 pb-8 max-w-2xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-extrabold text-white">Settings</h1>
        <p className="text-muted text-sm mt-0.5">Manage integrations, banks, wallets, and account</p>
      </div>

      {isLoading ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-40 bg-card rounded-3xl border border-white/5" />
          <div className="h-40 bg-card rounded-3xl border border-white/5" />
          <div className="h-28 bg-card rounded-3xl border border-white/5" />
        </div>
      ) : (
        <div className="space-y-6">

          {/* ════════════════════════════════════════ */}
          {/* EMAIL SYNC SECTION */}
          {/* ════════════════════════════════════════ */}
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

              {/* Auto-synced Senders (dynamic from wallets) */}
              <div className="pt-3 border-t border-white/5">
                <p className="text-xs text-muted font-semibold mb-2">Auto-synced senders:</p>
                <ul className="text-xs text-muted/80 space-y-1 font-mono pl-2">
                  {allSenders.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="text-accent">•</span>
                      <span>{s.sender}</span>
                      <span className="text-muted/50 text-[10px] font-sans">({s.name})</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* ════════════════════════════════════════ */}
          {/* BANKS & WALLETS SECTION */}
          {/* ════════════════════════════════════════ */}
          <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-5">
            <div className="flex items-center justify-between border-b border-white/5 pb-3">
              <h2 className="text-xs font-semibold text-muted uppercase tracking-wider">
                Banks & Wallets
              </h2>
              <button
                onClick={openAddWallet}
                className="px-4 py-2 bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 rounded-xl text-xs font-bold transition-all min-h-[40px] flex items-center gap-1.5"
              >
                <span>+</span> Add Wallet
              </button>
            </div>

            {/* Wallet List */}
            <div className="space-y-2">
              {wallets.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-muted text-sm">No wallets configured yet.</p>
                  <p className="text-muted/50 text-xs mt-1">Add your bank accounts, mobile wallets, and cash wallets.</p>
                </div>
              ) : (
                wallets.map(w => {
                  const typeInfo = WALLET_TYPES.find(t => t.value === w.type) || WALLET_TYPES[0]
                  const wColor = w.color || '#22c55e'
                  const isInactive = w.is_active === false

                  return (
                    <div
                      key={w.id}
                      className={`p-4 rounded-2xl border transition-all ${
                        isInactive
                          ? 'bg-background/30 border-white/5 opacity-50'
                          : 'bg-background/50 border-white/5 hover:border-white/10'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          {/* Color dot */}
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: wColor }}
                          />
                          <span className="text-lg flex-shrink-0">{typeInfo.icon}</span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-bold text-white truncate">{w.name}</h3>
                              {w.account_last4 && (
                                <span className="text-[10px] text-muted font-mono">••{w.account_last4}</span>
                              )}
                              {isInactive && (
                                <span className="text-[9px] bg-white/5 text-muted px-1.5 py-0.5 rounded-full uppercase font-bold">
                                  Inactive
                                </span>
                              )}
                            </div>
                            {w.alert_sender && (
                              <p className="text-[10px] text-muted/60 font-mono truncate">{w.alert_sender}</p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-3 flex-shrink-0">
                          <p className="text-sm font-extrabold text-white">{formatNaira(w.balance)}</p>

                          {/* Action buttons */}
                          <div className="flex gap-1">
                            <button
                              onClick={() => openEditWallet(w)}
                              className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-muted hover:text-white transition-colors text-xs"
                              title="Edit"
                            >
                              ✏️
                            </button>
                            <button
                              onClick={() => handleToggleActive(w)}
                              className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors text-xs ${
                                isInactive
                                  ? 'bg-accent/10 hover:bg-accent/20 text-accent'
                                  : 'bg-white/5 hover:bg-orange-500/10 text-muted hover:text-orange-400'
                              }`}
                              title={isInactive ? 'Reactivate' : 'Deactivate'}
                            >
                              {isInactive ? '✅' : '⏸️'}
                            </button>
                            {deletingWalletId === w.id ? (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => handleDeleteWallet(w.id)}
                                  className="px-2 py-1 bg-red-500/20 text-red-400 rounded-lg text-[10px] font-bold hover:bg-red-500/30 min-h-[36px]"
                                >
                                  Confirm
                                </button>
                                <button
                                  onClick={() => setDeletingWalletId(null)}
                                  className="px-2 py-1 bg-white/5 text-muted rounded-lg text-[10px] font-bold hover:bg-white/10 min-h-[36px]"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setDeletingWalletId(w.id)}
                                className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/5 hover:bg-red-500/10 text-muted hover:text-red-400 transition-colors text-xs"
                                title="Delete"
                              >
                                🗑️
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>

            {/* Threshold Setting */}
            <form onSubmit={handleSaveThreshold} className="space-y-3 pt-3 border-t border-white/5">
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

          {/* ════════════════════════════════════════ */}
          {/* ACCOUNT SECTION */}
          {/* ════════════════════════════════════════ */}
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

      {/* ════════════════════════════════════════ */}
      {/* ADD / EDIT WALLET MODAL */}
      {/* ════════════════════════════════════════ */}
      {showWalletModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card p-6 rounded-3xl w-full max-w-md border border-white/10 relative max-h-[90vh] overflow-y-auto">
            <button
              onClick={() => setShowWalletModal(false)}
              className="absolute top-4 right-4 text-muted hover:text-white w-10 h-10 flex items-center justify-center rounded-full hover:bg-white/10"
            >
              ✕
            </button>

            <h2 className="text-xl font-bold text-white mb-5">
              {editingWallet ? 'Edit Wallet' : 'Add New Wallet'}
            </h2>

            <form onSubmit={handleSaveWallet} className="space-y-4">
              {/* Name */}
              <div>
                <label className="block text-xs text-muted font-semibold mb-1">Wallet Name *</label>
                <input
                  type="text"
                  value={walletForm.name}
                  onChange={(e) => setWalletForm({ ...walletForm, name: e.target.value })}
                  placeholder="e.g. GTBank, PiggyVest"
                  required
                  className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm placeholder-muted/40 focus:outline-none focus:border-accent min-h-[48px]"
                />
              </div>

              {/* Type */}
              <div>
                <label className="block text-xs text-muted font-semibold mb-1">Type</label>
                <div className="grid grid-cols-5 gap-1.5">
                  {WALLET_TYPES.map(t => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setWalletForm({ ...walletForm, type: t.value })}
                      className={`flex flex-col items-center gap-1 p-2.5 rounded-xl border text-xs font-medium transition-all min-h-[48px] ${
                        walletForm.type === t.value
                          ? 'bg-accent/10 border-accent/30 text-accent'
                          : 'bg-background/50 border-white/5 text-muted hover:border-white/10'
                      }`}
                    >
                      <span className="text-lg">{t.icon}</span>
                      <span className="text-[10px]">{t.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Balance */}
              <div>
                <label className="block text-xs text-muted font-semibold mb-1">
                  {editingWallet ? 'Current Balance' : 'Opening Balance'}
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted font-bold">₦</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={walletForm.balance}
                    onChange={(e) => setWalletForm({ ...walletForm, balance: e.target.value })}
                    placeholder="0.00"
                    className="w-full pl-9 pr-4 py-3 bg-background border border-white/10 rounded-xl text-white font-bold text-sm placeholder-muted/40 focus:outline-none focus:border-accent min-h-[48px]"
                  />
                </div>
              </div>

              {/* Alert Sender Email */}
              <div>
                <label className="block text-xs text-muted font-semibold mb-1">
                  Alert Email Sender
                </label>
                <p className="text-[10px] text-muted/60 mb-1.5">
                  The From address of transaction notification emails (e.g. GeNS@gtbank.com)
                </p>
                <input
                  type="email"
                  value={walletForm.alert_sender}
                  onChange={(e) => setWalletForm({ ...walletForm, alert_sender: e.target.value })}
                  placeholder="alerts@bank.com"
                  className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm font-mono placeholder-muted/40 focus:outline-none focus:border-accent min-h-[48px]"
                />
              </div>

              {/* Account Last 4 */}
              <div>
                <label className="block text-xs text-muted font-semibold mb-1">Account Last 4 Digits</label>
                <input
                  type="text"
                  maxLength={4}
                  value={walletForm.account_last4}
                  onChange={(e) => setWalletForm({ ...walletForm, account_last4: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                  placeholder="1234"
                  className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm font-mono placeholder-muted/40 focus:outline-none focus:border-accent min-h-[48px]"
                />
              </div>

              {/* Color Picker */}
              <div>
                <label className="block text-xs text-muted font-semibold mb-2">Color</label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setWalletForm({ ...walletForm, color: c })}
                      className={`w-9 h-9 rounded-full border-2 transition-all ${
                        walletForm.color === c ? 'border-white scale-110' : 'border-transparent hover:scale-105'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>

              {/* Active toggle */}
              <div className="flex items-center justify-between p-3 bg-background/50 rounded-xl border border-white/5">
                <span className="text-xs text-muted font-semibold">Active</span>
                <button
                  type="button"
                  onClick={() => setWalletForm({ ...walletForm, is_active: !walletForm.is_active })}
                  className={`w-12 h-7 rounded-full transition-all relative ${
                    walletForm.is_active ? 'bg-accent' : 'bg-white/10'
                  }`}
                >
                  <div
                    className={`w-5 h-5 bg-white rounded-full absolute top-1 transition-all ${
                      walletForm.is_active ? 'left-6' : 'left-1'
                    }`}
                  />
                </button>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={savingWallet}
                className="w-full py-3.5 bg-accent hover:bg-accent/90 text-black font-bold text-sm rounded-xl transition-all shadow-md shadow-accent/20 min-h-[48px] disabled:opacity-50"
              >
                {savingWallet ? 'Saving...' : editingWallet ? 'Update Wallet' : 'Add Wallet'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
