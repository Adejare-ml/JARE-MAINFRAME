import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { sanitizeSlug } from '../lib/walletRouting'
import { walletUpdatePayload } from '../lib/wallets'
import { timeAgo } from '../lib/formatters'
import { walletAlertStatus } from '../lib/health'
import { toast } from '../lib/toast'
import { useAuth } from '../hooks/useAuth'
import { secondaryItems } from '../lib/nav'
import ErrorState from '../components/ui/ErrorState'
import Sheet from '../components/ui/Sheet'
import CategoryRules from '../components/settings/CategoryRules'
import CategoryBudgets from '../components/settings/CategoryBudgets'
import CustomCategories from '../components/settings/CustomCategories'
import Reminders from '../components/settings/Reminders'
import SystemHealth from '../components/settings/SystemHealth'
import ExportData from '../components/settings/ExportData'
import DiscoveredAccountsSettings from '../components/settings/DiscoveredAccountsSettings'
import { SettingsSkeleton } from '../components/ui/PageSkeleton'
import { isOledEnabled, setOledEnabled, getThemeMode, setThemeMode } from '../lib/theme'
import { CALORIE_TARGET_KEY, CALORIE_TARGET_MIN, CALORIE_TARGET_MAX, parseCalorieTarget } from '../lib/meals'
import Icon from '../components/ui/Icon'
import PageHeader from '../components/ui/PageHeader'
import Panel from '../components/ui/Panel'
import ListRow, { ListRows } from '../components/ui/ListRow'
import Button from '../components/ui/Button'
import Money from '../components/ui/Money'
import Segmented from '../components/ui/Segmented'
import EmptyState from '../components/ui/EmptyState'
import Label from '../components/ui/Label'
import { Input, Select } from '../components/ui/Field'
import { SheetHeader } from '../components/settings/parts'

const WALLET_TYPES = [
  { value: 'bank', label: 'Bank', icon: 'bank' },
  { value: 'mobile', label: 'Mobile Money', icon: 'phone' },
  { value: 'cash', label: 'Cash', icon: 'cash' },
  { value: 'savings', label: 'Savings', icon: 'vault' },
  { value: 'investment', label: 'Investment', icon: 'chart' },
]

// Wallet colours are the owner's data (wallets.color), stored as hex and
// drawn only as a swatch; they are not interface colours.
const PRESET_COLORS = [
  '#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

export default function Settings() {
  const { signOut } = useAuth()
  const location = useLocation()

  const [isLoading, setIsLoading] = useState(true)
  // Every other page has had this since Track A; Settings did not, and swallowed
  // its errors instead. A backend failure rendered "no wallets, Gmail
  // disconnected, no thresholds" -- the exact opposite of the truth, on the very
  // page Budget's setup gate sends you to when it thinks you have no wallets.
  // Following that invitation creates duplicate wallets, duplicate source_slug
  // values, and a sync that no longer knows which row to update.
  const [pageError, setPageError] = useState(null)

  // Wallets & Threshold State
  const [wallets, setWallets] = useState([])
  const [threshold, setThreshold] = useState('10000')
  const [savingThreshold, setSavingThreshold] = useState(false)
  const [budgetTarget, setBudgetTarget] = useState('85000')
  // Daily calories for the Meals page. Blank until set; the ring draws an
  // empty track rather than a target nobody chose.
  const [calorieTarget, setCalorieTarget] = useState('')
  const [savingCalorieTarget, setSavingCalorieTarget] = useState(false)
  const [savingBudgetTarget, setSavingBudgetTarget] = useState(false)

  // Appearance & planner voice
  const [oledEnabled, setOledEnabledState] = useState(isOledEnabled)
  const [themeMode, setThemeModeState] = useState(getThemeMode)
  const [plannerTone, setPlannerTone] = useState('encouraging')

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
    parse_strategy: 'auto',
  })
  const [savingWallet, setSavingWallet] = useState(false)
  // Progressive disclosure: sync/cosmetic fields collapsed behind this on a
  // new wallet, expanded already when editing one. See openAddWallet.
  const [showAdvancedWalletFields, setShowAdvancedWalletFields] = useState(false)

  // Delete confirm -- the wallet itself, not just its id, so the modal below
  // can name it. A hard delete (unlike deactivating, which is one click away
  // right next to it) removes the row every past transaction's wallet_id
  // points at, permanently -- the one genuinely irreversible action on this
  // page, and the only one that gets a full blocking modal rather than an
  // inline confirm.
  const [deletingWallet, setDeletingWallet] = useState(null)

  const loadData = async () => {
    try {
      setIsLoading(true)
      setPageError(null)

      // 1. Fetch User Email
      const { data: { user } } = await supabase.auth.getUser()
      if (user?.email) {
        setUserEmail(user.email)
      }

      // 3. Fetch Wallets
      // The error was previously not destructured at all, so a failed query
      // rendered as an empty wallet list -- the single most dangerous lie this
      // page could tell.
      const { data: wData, error: wErr } = await supabase
        .from('wallets')
        .select('*')
        .order('created_at', { ascending: true })
      if (wErr) throw wErr
      setWallets(wData || [])

      // 4. Fetch both money settings, and the planner's voice, in one query
      const { data: settingRows, error: setErr } = await supabase
        .from('user_settings')
        .select('key, value')
        .in('key', ['low_balance_threshold', 'monthly_budget_target', 'planner_tone', CALORIE_TARGET_KEY])

      if (setErr) throw setErr

      for (const row of settingRows || []) {
        if (!row.value) continue
        if (row.key === 'low_balance_threshold') setThreshold(row.value)
        if (row.key === 'monthly_budget_target') setBudgetTarget(row.value)
        if (row.key === CALORIE_TARGET_KEY) setCalorieTarget(row.value ?? '')
        if (row.key === 'planner_tone' && (row.value === 'stern' || row.value === 'encouraging')) {
          setPlannerTone(row.value)
        }
      }
    } catch (err) {
      console.error('Error loading Settings data:', err)
      setPageError(err.message || 'Failed to load')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  // /settings#system (the status rail, Daily HQ), #discovered and #reminders
  // (push and setup links) land on their section. The sections only exist
  // once the page has loaded, so this waits for that rather than the route.
  useEffect(() => {
    if (isLoading || pageError) return
    const id = decodeURIComponent(location.hash.slice(1))
    if (!id) return
    // The sections above System load on their own and arrive in any order,
    // each pushing it down; keep it in place while they settle (at most two
    // seconds), and let go as soon as the owner scrolls or touches.
    const scroll = () => document.getElementById(id)?.scrollIntoView({ block: 'start' })
    const frame = requestAnimationFrame(scroll)
    const observer = new ResizeObserver(scroll)
    observer.observe(document.body)
    const release = () => observer.disconnect()
    const timer = setTimeout(release, 2000)
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown']
    events.forEach((e) => window.addEventListener(e, release, { once: true, passive: true }))
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      release()
      events.forEach((e) => window.removeEventListener(e, release))
    }
  }, [isLoading, pageError, location.hash])

  // ── Settings Handlers ──

  const saveSetting = async (key, rawValue, label) => {
    const num = parseFloat(rawValue)
    if (isNaN(num) || num < 0) {
      toast.error(`Please enter a valid ${label.toLowerCase()}`)
      return false
    }

    try {
      const now = new Date().toISOString()

      const { data: existing } = await supabase
        .from('user_settings')
        .select('id')
        .eq('key', key)
        .maybeSingle()

      const { error } = existing
        ? await supabase
            .from('user_settings')
            .update({ value: String(num), updated_at: now })
            .eq('id', existing.id)
        : await supabase
            .from('user_settings')
            .insert({ key, value: String(num), updated_at: now })
      if (error) throw error

      toast.success(`${label} saved`)
      return true
    } catch (err) {
      console.error(`Error saving ${key}:`, err)
      toast.error(`Failed to save ${label.toLowerCase()}: ` + (err.message || 'Check connection'))
      return false
    }
  }

  /**
   * Instant, like a toggle, not a form with a submit button -- one tap and it
   * takes effect, the same way a wallet's Active switch does. Optimistic:
   * the tone changes on screen before the write confirms, rolled back if it
   * fails.
   */
  const handleSetPlannerTone = async (tone) => {
    const previous = plannerTone
    setPlannerTone(tone)

    try {
      const now = new Date().toISOString()
      const { data: existing } = await supabase
        .from('user_settings')
        .select('id')
        .eq('key', 'planner_tone')
        .maybeSingle()

      const { error } = existing
        ? await supabase.from('user_settings').update({ value: tone, updated_at: now }).eq('id', existing.id)
        : await supabase.from('user_settings').insert({ key: 'planner_tone', value: tone, updated_at: now })
      if (error) throw error
    } catch (err) {
      console.error('Error saving planner tone:', err)
      setPlannerTone(previous)
      toast.error('Could not save that: ' + (err.message || 'check connection'))
    }
  }

  const handleSaveThreshold = async (e) => {
    e.preventDefault()
    setSavingThreshold(true)
    await saveSetting('low_balance_threshold', threshold, 'Threshold')
    setSavingThreshold(false)
  }

  const handleSaveBudgetTarget = async (e) => {
    e.preventDefault()
    setSavingBudgetTarget(true)
    await saveSetting('monthly_budget_target', budgetTarget, 'Budget target')
    setSavingBudgetTarget(false)
  }

  const handleSaveCalorieTarget = async (e) => {
    e.preventDefault()
    if (parseCalorieTarget(calorieTarget) == null) {
      toast.error(`A daily target is between ${CALORIE_TARGET_MIN} and ${CALORIE_TARGET_MAX} kcal`)
      return
    }
    setSavingCalorieTarget(true)
    await saveSetting(CALORIE_TARGET_KEY, calorieTarget, 'Calorie target')
    setSavingCalorieTarget(false)
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
      parse_strategy: 'auto',
    })
    // Collapsed for a brand-new wallet: three fields (name, type, opening
    // balance) are everything the ledger actually needs to start, and every
    // field behind this defaults to something sane already (auto-detect
    // parsing, active, accent green). Expanded by default when editing --
    // see openEditWallet -- since changing an existing wallet's sync setup
    // is exactly why someone opens that form.
    setShowAdvancedWalletFields(false)
    setShowWalletModal(true)
  }

  const openEditWallet = (wallet) => {
    setEditingWallet(wallet)
    setShowAdvancedWalletFields(true)
    setWalletForm({
      name: wallet.name || '',
      type: wallet.type || 'bank',
      balance: String(wallet.balance || ''),
      alert_sender: wallet.alert_sender || '',
      account_last4: wallet.account_last4 || '',
      color: wallet.color || '#22c55e',
      is_active: wallet.is_active !== false,
      // Kept as stored: the column is unused since the token sync was
      // retired, and an edit must not rewrite it.
      parse_strategy: wallet.parse_strategy || 'auto',
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
      // The balance is sent only when it was changed in the form (see
      // src/lib/wallets.js): an edit sheet opened before the morning audit
      // and saved after it used to put the old balance back.
      const { payload, balanceChanged } = walletUpdatePayload(walletForm, editingWallet)

      if (editingWallet) {
        // source_slug is deliberately absent from edits: it is half of every
        // transaction's dedup key, and a rename must never re-key history.
        const { error } = await supabase
          .from('wallets')
          .update(payload)
          .eq('id', editingWallet.id)
        if (error) throw error
        toast.success(balanceChanged ? 'Wallet updated, balance set' : 'Wallet updated')
      } else {
        // Set once at creation and never rewritten. Leaving it null made
        // walletSource() fall back to the display name -- reintroducing the
        // rename-re-keys-the-ledger bug for every wallet added post-migration.
        const { error } = await supabase
          .from('wallets')
          .insert({ ...payload, source_slug: sanitizeSlug(payload.name) })
        if (error) {
          if (error.code === '23505') {
            toast.error(`A wallet with the identity "${sanitizeSlug(payload.name)}" already exists. Pick a more distinct name (e.g. "GTBank Savings").`)
            return
          }
          throw error
        }
        toast.success('Wallet added')
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
      setDeletingWallet(null)
      await loadData()
    } catch (err) {
      toast.error('Failed to delete wallet: ' + (err.message || 'Unknown error'))
    }
  }

  const closeWalletSheet = () => setShowWalletModal(false)

  return (
    <div className="space-y-3 pb-8 max-w-2xl mx-auto">
      <PageHeader title="Settings" meta="Wallets, alerts, appearance, system" />

      {isLoading ? (
        <SettingsSkeleton />
      ) : pageError ? (
        <ErrorState message={pageError} onRetry={loadData} />
      ) : (
        <div className="space-y-3">
          {/* Modules: phone only, the sidebar carries these on desktop. */}
          {secondaryItems().length > 0 && (
            <nav aria-label="More modules" className="lg:hidden">
              <Panel label="More" flush>
                <ListRows>
                  {secondaryItems().map((item) => (
                    <ListRow
                      key={item.path}
                      to={item.path}
                      leading={<Icon name={item.icon} size={20} className="text-muted" />}
                      title={item.label}
                      trailing={<Icon name="chevR" size={18} className="text-muted" />}
                    />
                  ))}
                </ListRows>
              </Panel>
            </nav>
          )}

          <Panel label="Bank alerts">
            {/* The Connect / Sync Now / Disconnect trio lived here until 26 Sep
                2026. Sync Now re-imported alerts the morning audit had already
                recorded, and Disconnect deleted the row that audit stamps, so
                System read "never checked" for good. Nothing here to press now:
                the reading happens outside the app, and its state is below. */}
            <div className="space-y-2">
              <p className="text-body-sm text-foreground">
                Read every morning by the scheduled audit, which files each GTBank, OPay, Stanbic, PalmPay, Zenith and
                PiggyVest alert straight into the ledger. Anything it was unsure about waits in the review queue on
                Transactions, and so does any transfer to someone other than you: a payment the bank calls a transfer is
                spending here until you say which kind.
              </p>
              <p className="text-body-sm text-muted">
                A wallet is matched by its slug (gtbank, opay, stanbic, palmpay, zenith, piggyvest), set under Banks and
                wallets below. Whether the import is alive, and when it last ran, is under System further down.
              </p>
            </div>
          </Panel>

          <Panel
            label="Banks and wallets"
            meta={wallets.length > 0 ? `${wallets.length}` : null}
            action={
              <Button size="sm" variant="secondary" icon="plus" onClick={openAddWallet}>
                Add wallet
              </Button>
            }
            flush
          >
            {wallets.length === 0 ? (
              <EmptyState
                title="No wallets yet"
                message="Add your bank accounts, mobile wallets and cash."
                actionLabel="Add wallet"
                onAction={openAddWallet}
              />
            ) : (
              <ListRows as="ul" label="Wallets">
                {wallets.map((w) => {
                  const typeInfo = WALLET_TYPES.find((t) => t.value === w.type) || WALLET_TYPES[0]
                  const isInactive = w.is_active === false
                  // Whether this bank has been heard from: the one code-side
                  // sign that the audit reads this sender. From balance_as_of,
                  // which the ingest function stamps on every alert that moves
                  // the balance.
                  const heard = walletAlertStatus(w)
                  const quiet = heard.status === 'quiet' || heard.status === 'never'
                  const heardText =
                    heard.status === 'n/a'
                      ? null
                      : heard.status === 'never'
                        ? 'No alert recorded yet'
                        : `Last alert ${timeAgo(heard.lastAlertAt)}`
                  return (
                    <li key={w.id}>
                      <ListRow
                        onClick={() => openEditWallet(w)}
                        label={`Edit ${w.name}`}
                        leading={
                          <span
                            aria-hidden="true"
                            className={`relative inline-flex items-center justify-center w-7 h-7 shrink-0 rounded-chip bg-surface-2 ${
                              isInactive ? 'text-muted-dim' : 'text-muted'
                            }`}
                          >
                            <Icon name={typeInfo.icon} size={16} />
                            {/* The wallet's own colour, as the owner chose it. */}
                            <span
                              className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-card"
                              style={{ backgroundColor: w.color || 'var(--color-accent)' }}
                            />
                          </span>
                        }
                        title={
                          <>
                            {w.name}
                            {w.account_last4 && <span className="type-data text-muted-dim"> ••{w.account_last4}</span>}
                          </>
                        }
                        subtitle={
                          isInactive || heardText ? (
                            <>
                              {isInactive && 'Inactive'}
                              {isInactive && heardText && ' · '}
                              {heardText && <span className={quiet ? 'text-warn' : undefined}>{heardText}</span>}
                            </>
                          ) : null
                        }
                        meta={w.alert_sender || null}
                        trailing={
                          <>
                            <Money amount={w.balance} tone={isInactive ? 'muted' : 'default'} />
                            <Icon name="chevR" size={18} className="text-muted" />
                          </>
                        }
                      />
                    </li>
                  )
                })}
              </ListRows>
            )}

            <div className="border-t border-border p-3 lg:p-4 space-y-4">
              <NumberSetting
                id="low-balance"
                label="Low balance warning"
                hint="In naira. Wallets below this amount are flagged on Daily HQ."
                value={threshold}
                onChange={setThreshold}
                placeholder="10000"
                onSubmit={handleSaveThreshold}
                saving={savingThreshold}
              />
              <NumberSetting
                id="budget-target"
                label="Monthly budget target"
                hint={'In naira. Daily HQ\'s "% of budget" bar measures this month\'s spending against it.'}
                value={budgetTarget}
                onChange={setBudgetTarget}
                placeholder="85000"
                onSubmit={handleSaveBudgetTarget}
                saving={savingBudgetTarget}
              />
            </div>
          </Panel>

          <Panel label="Appearance and planner">
            <div className="space-y-5">
              <div className="space-y-1.5">
                <Label as="p">Theme</Label>
                <Segmented
                  full
                  label="Theme"
                  value={themeMode}
                  onChange={(value) => {
                    setThemeMode(value)
                    setThemeModeState(value)
                  }}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' },
                    { value: 'system', label: 'System' },
                  ]}
                />
                <p className="text-body-sm text-muted">System follows your device. Per device, not synced.</p>
              </div>

              <div className="space-y-1.5">
                <Label as="p">True black (OLED)</Label>
                <Segmented
                  full
                  label="True black (OLED)"
                  value={oledEnabled ? 'on' : 'off'}
                  onChange={(value) => {
                    const next = value === 'on'
                    setOledEnabled(next)
                    setOledEnabledState(next)
                  }}
                  options={[
                    { value: 'off', label: 'Off' },
                    { value: 'on', label: 'On' },
                  ]}
                />
                <p className="text-body-sm text-muted">A pure black background instead of dark grey. Per device, not synced.</p>
              </div>

              <div className="space-y-1.5">
                <Label as="p">Planner tone</Label>
                <Segmented
                  full
                  label="Planner tone"
                  value={plannerTone}
                  onChange={handleSetPlannerTone}
                  options={[
                    { value: 'encouraging', label: 'Encouraging' },
                    { value: 'stern', label: 'Tough love' },
                  ]}
                />
                <p className="text-body-sm text-muted">
                  How Daily HQ&apos;s proactive line talks to you about money. Same facts either way:{' '}
                  {plannerTone === 'stern' ? '"On pace, for now."' : '"On pace this month."'}
                </p>
              </div>
            </div>
          </Panel>

          <DiscoveredAccountsSettings />

          <Panel label="Meals">
            <div className="space-y-3">
              <p className="text-body-sm text-muted">
                The Meals page photographs a plate and estimates its calories (the analyze-meal edge function; see
                README). The target below is what the day&apos;s ring fills towards. Most adults land between 1,800 and
                2,600 kcal; a dietitian&apos;s figure beats a guess.
              </p>
              {/* Added for the Diet module, Phase 1: Diet keeps its own targets
                  (diet_settings, 048), copied from this one once by 049. This
                  field still saves, but nothing reads it now. */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-body-sm text-foreground min-w-0">
                  Diet has replaced the Meals page and keeps its own calorie and protein targets.
                </p>
                <Button size="sm" variant="secondary" to="/diet?tab=settings">
                  Diet settings
                </Button>
              </div>
              <NumberSetting
                id="calorie-target"
                label="Daily calorie target"
                hint={`Between ${CALORIE_TARGET_MIN} and ${CALORIE_TARGET_MAX} kcal.`}
                value={calorieTarget}
                onChange={setCalorieTarget}
                placeholder="e.g. 2200"
                inputMode="numeric"
                min={CALORIE_TARGET_MIN}
                max={CALORIE_TARGET_MAX}
                step="50"
                required={false}
                onSubmit={handleSaveCalorieTarget}
                saving={savingCalorieTarget}
              />
            </div>
          </Panel>

          <CategoryRules />
          <CategoryBudgets />
          <CustomCategories />
          <Reminders />
          <SystemHealth />
          <ExportData />

          <Panel label="Account">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-body-sm text-muted">Signed in as</p>
                <p className="type-data text-foreground truncate">{userEmail || 'Adejare Adelugba'}</p>
              </div>
              <Button variant="danger" icon="signout" onClick={signOut} className="w-full sm:w-auto">
                Log out
              </Button>
            </div>
          </Panel>
        </div>
      )}

      {/* Add / edit wallet */}
      <Sheet isOpen={showWalletModal} onClose={closeWalletSheet} title={editingWallet ? 'Edit wallet' : 'Add wallet'} alwaysCenter>
        <SheetHeader title={editingWallet ? 'Edit wallet' : 'Add wallet'} onClose={closeWalletSheet} />
        <form onSubmit={handleSaveWallet} className="p-4 space-y-4 overflow-y-auto">
          <Input
            label="Wallet name"
            type="text"
            value={walletForm.name}
            onChange={(e) => setWalletForm({ ...walletForm, name: e.target.value })}
            placeholder="e.g. GTBank, PiggyVest"
            required
          />

          <Select label="Type" value={walletForm.type} onChange={(e) => setWalletForm({ ...walletForm, type: e.target.value })}>
            {WALLET_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>

          <Input
            label={editingWallet ? 'Current balance' : 'Opening balance'}
            hint="In naira."
            type="number"
            inputMode="decimal"
            step="0.01"
            value={walletForm.balance}
            onChange={(e) => setWalletForm({ ...walletForm, balance: e.target.value })}
            placeholder="0.00"
          />

          {/* Everything below is optional: sane defaults already cover it
              (auto-detect parsing, active, accent green), so a brand-new
              wallet does not have to face all seven fields before it can
              be saved. Collapsed on add, expanded on edit -- see
              openAddWallet/openEditWallet. */}
          <Button
            variant="ghost"
            full
            icon={showAdvancedWalletFields ? 'chevU' : 'chevD'}
            onClick={() => setShowAdvancedWalletFields((v) => !v)}
            aria-expanded={showAdvancedWalletFields}
          >
            Advanced: sync and appearance
          </Button>

          {showAdvancedWalletFields && (
            <>
              <Input
                label="Alert email sender"
                hint="The From address of transaction emails, such as GeNS@gtbank.com."
                type="email"
                value={walletForm.alert_sender}
                onChange={(e) => setWalletForm({ ...walletForm, alert_sender: e.target.value })}
                placeholder="alerts@bank.com"
                className="font-mono"
              />

              <Input
                label="Account last 4 digits"
                type="text"
                inputMode="numeric"
                maxLength={4}
                value={walletForm.account_last4}
                onChange={(e) => setWalletForm({ ...walletForm, account_last4: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder="1234"
                className="font-mono"
              />

              <div className="space-y-1.5">
                <Label as="p">Colour</Label>
                <div className="flex flex-wrap gap-1">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setWalletForm({ ...walletForm, color: c })}
                      aria-pressed={walletForm.color === c}
                      aria-label={`Colour ${c}`}
                      className="press w-12 h-12 flex items-center justify-center rounded-control"
                    >
                      <span
                        className={`w-8 h-8 rounded-full ${
                          walletForm.color === c ? 'ring-2 ring-foreground ring-offset-2 ring-offset-card' : ''
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label as="p">Status</Label>
                <Segmented
                  full
                  label="Wallet status"
                  value={walletForm.is_active ? 'active' : 'inactive'}
                  onChange={(value) => setWalletForm({ ...walletForm, is_active: value === 'active' })}
                  options={[
                    { value: 'active', label: 'Active' },
                    { value: 'inactive', label: 'Inactive' },
                  ]}
                />
              </div>
            </>
          )}

          <Button type="submit" full loading={savingWallet}>
            {savingWallet ? 'Saving…' : editingWallet ? 'Update wallet' : 'Add wallet'}
          </Button>

          {/* Deactivate and delete used to sit on each wallet row as glyph
              buttons; at phone width they crowded the name and balance out,
              so they live with the rest of the wallet's controls. */}
          {editingWallet && (
            <div className="flex gap-2 pt-4 border-t border-border">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={async () => {
                  closeWalletSheet()
                  await handleToggleActive(editingWallet)
                }}
              >
                {editingWallet.is_active === false ? 'Reactivate' : 'Deactivate'}
              </Button>
              <Button
                variant="danger"
                icon="trash"
                className="flex-1"
                onClick={() => {
                  closeWalletSheet()
                  setDeletingWallet(editingWallet)
                }}
              >
                Delete
              </Button>
            </div>
          )}
        </form>
      </Sheet>

      {/* Deleting a wallet, unlike everything else on this page, cannot be
          undone -- deactivating (one tap, right next to this button) already
          covers "I don't use this anymore" without losing the row every past
          transaction's wallet_id points at. A full blocking modal, not the
          inline two-button confirm every lower-stakes action on this app
          uses, because this is the one action here that actually earns it. */}
      <Sheet
        isOpen={Boolean(deletingWallet)}
        onClose={() => setDeletingWallet(null)}
        title={`Delete ${deletingWallet?.name || 'wallet'}?`}
        alwaysCenter
      >
        <SheetHeader title="Delete this wallet?" onClose={() => setDeletingWallet(null)} />
        <div className="p-4 space-y-3">
          <p className="text-body text-foreground">
            <span className="font-semibold">{deletingWallet?.name}</span> and its balance history will be gone
            permanently. Transactions already logged against it stay in the ledger, but nothing will point back to it.
          </p>
          <p className="text-body-sm text-muted">
            If you just don&apos;t use this wallet anymore, deactivating it instead keeps its history in every
            month&apos;s totals and only leaves its balance out of net worth.
          </p>
          <div className="flex gap-2 pt-2">
            <Button variant="danger" className="flex-1" onClick={() => handleDeleteWallet(deletingWallet.id)}>
              Delete permanently
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => setDeletingWallet(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  )
}

/**
 * One saved number: a labelled input and its Save button on one line, the
 * hint under both. The three money and calorie settings share it.
 */
function NumberSetting({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  onSubmit,
  saving,
  inputMode = 'decimal',
  required = true,
  ...inputProps
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-1.5">
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <Input
            id={id}
            label={label}
            type="number"
            inputMode={inputMode}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            aria-describedby={`${id}-hint`}
            {...inputProps}
          />
        </div>
        <Button type="submit" variant="secondary" loading={saving}>
          Save
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-body-sm text-muted">
        {hint}
      </p>
    </form>
  )
}
