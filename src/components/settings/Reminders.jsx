import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { hasColumn } from '../../lib/schema'
import { urlBase64ToUint8Array, subscriptionToRow, pushSupport, SUPPORT_MESSAGES } from '../../lib/push'
import Panel from '../ui/Panel'
import ListRow, { ListRows } from '../ui/ListRow'
import Button from '../ui/Button'
import IconButton from '../ui/IconButton'
import Badge from '../ui/Badge'
import { Notice, Code } from './parts'

/**
 * Turn the morning reminder on or off for this device.
 *
 * A subscription belongs to one browser on one device, so the switch is
 * per device and the list below says which ones are in. Enabling asks the
 * browser for permission, subscribes through the service worker
 * (public/sw.js shows the notification), and stores the endpoint and keys
 * in push_subscriptions (migration 031) for scripts/remind.mjs to send to.
 * Disabling unsubscribes here and deletes the row -- the script then has
 * nothing to send to, which is the whole point.
 *
 * The VAPID public key is public by design (see .env.example); without it
 * the section says so rather than failing on the first tap.
 */

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

export default function Reminders() {
  const available = hasColumn('push_subscriptions.endpoint')
  const support = pushSupport({ navigator: globalThis.navigator, window: globalThis.window })

  const [current, setCurrent] = useState(null) // this browser's PushSubscription, if any
  const [devices, setDevices] = useState([])
  const [permission, setPermission] = useState(() => globalThis.Notification?.permission || 'default')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const [sub, rows] = await Promise.all([
      support.supported
        ? navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).catch(() => null)
        : Promise.resolve(null),
      available
        ? supabase
            .from('push_subscriptions')
            .select('id, endpoint, user_agent, created_at, last_used_at, failed_at')
            .order('created_at', { ascending: true })
        : Promise.resolve({ data: [] }),
    ])
    setCurrent(sub)
    if (rows.error) console.warn('Could not load reminder devices:', rows.error.message)
    setDevices(rows.error ? [] : rows.data || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const enable = async () => {
    if (!VAPID_PUBLIC_KEY) {
      toast.error('Set VITE_VAPID_PUBLIC_KEY and redeploy first')
      return
    }
    setBusy(true)
    try {
      const result = await Notification.requestPermission()
      setPermission(result)
      if (result !== 'granted') {
        toast.error('Notifications were not allowed')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }))
      const row = subscriptionToRow(sub, navigator.userAgent)
      if (!row) throw new Error('the browser returned a subscription without keys')

      const { error } = await supabase
        .from('push_subscriptions')
        .upsert(row, { onConflict: 'user_id,endpoint' })
      if (error) throw error

      toast.success('Reminders on for this device')
      await load()
    } catch (err) {
      console.error('Could not enable reminders:', err)
      toast.error('Could not enable: ' + (err?.message || 'try again'))
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    setBusy(true)
    try {
      const endpoint = current?.endpoint
      if (current) await current.unsubscribe()
      if (endpoint) {
        const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint)
        if (error) throw error
      }
      toast.success('Reminders off for this device')
      await load()
    } catch (err) {
      console.error('Could not disable reminders:', err)
      toast.error('Could not disable: ' + (err?.message || 'try again'))
    } finally {
      setBusy(false)
    }
  }

  const forget = async (device) => {
    const { error } = await supabase.from('push_subscriptions').delete().eq('id', device.id)
    if (error) {
      toast.error('Could not remove: ' + error.message)
      return
    }
    // If it was this browser, drop the local subscription too so the two
    // never disagree about whether this device is in.
    if (current && current.endpoint === device.endpoint) await current.unsubscribe().catch(() => {})
    await load()
  }

  if (loading) return null

  const thisDeviceOn = Boolean(current) && devices.some((d) => d.endpoint === current.endpoint)

  return (
    <Panel
      id="reminders"
      label="Reminders"
      className="scroll-mt-16"
      flush
      action={
        available &&
        support.supported && (
          <Button
            size="sm"
            variant={thisDeviceOn ? 'secondary' : 'primary'}
            icon="bell"
            onClick={thisDeviceOn ? disable : enable}
            loading={busy}
            aria-pressed={thisDeviceOn}
          >
            {busy ? 'Working…' : thisDeviceOn ? 'Turn off here' : 'Turn on here'}
          </Button>
        )
      }
    >
      <div className="p-3 lg:p-4 space-y-3">
        {!available ? (
          <Notice>
            Reminders need <Code>supabase/migrations/031_push_subscriptions.sql</Code>. Run it in the Supabase SQL editor
            and this section starts working.
          </Notice>
        ) : !support.supported ? (
          <p className="text-body-sm text-muted">{SUPPORT_MESSAGES[support.reason]}</p>
        ) : (
          <>
            <p className="text-body-sm text-muted">
              One notification each morning at 07:30 with what needs you: debts due, bills expected, urgent repairs,
              milestones past their date, and anything waiting for review. Nothing on a quiet day.
            </p>
            {!VAPID_PUBLIC_KEY && (
              <Notice>
                <Code>VITE_VAPID_PUBLIC_KEY</Code> is not set in this build, so this device cannot subscribe yet. Generate
                the pair with <Code>node scripts/generate-vapid.mjs</Code>.
              </Notice>
            )}
            {permission === 'denied' && (
              <Notice>Notifications are blocked for this site in the browser. Allow them in the site settings, then try again.</Notice>
            )}
          </>
        )}
      </div>

      {available && support.supported && devices.length > 0 && (
        <div className="border-t border-border">
          <ListRows as="ul" label="Devices">
            {devices.map((device) => {
              const isThis = current?.endpoint === device.endpoint
              const failed = device.failed_at && (!device.last_used_at || device.failed_at > device.last_used_at)
              return (
                <ListRow
                  key={device.id}
                  as="li"
                  title={describeDevice(device.user_agent)}
                  subtitle={
                    failed ? (
                      <span className="text-warn">Last send failed</span>
                    ) : device.last_used_at ? (
                      'Receiving'
                    ) : (
                      'Waiting for the first morning'
                    )
                  }
                  trailing={
                    <>
                      {isThis && <Badge label="This device" />}
                      <IconButton
                        name="trash"
                        label={`Remove ${describeDevice(device.user_agent)}`}
                        onClick={() => forget(device)}
                        className="-mr-2"
                      />
                    </>
                  }
                />
              )
            })}
          </ListRows>
        </div>
      )}
    </Panel>
  )
}

/** "Android · Chrome", "iPhone · Safari": enough to tell devices apart. */
function describeDevice(userAgent) {
  const ua = String(userAgent || '')
  const os = /iPhone/i.test(ua)
    ? 'iPhone'
    : /iPad/i.test(ua)
      ? 'iPad'
      : /Android/i.test(ua)
        ? 'Android'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Macintosh/i.test(ua)
            ? 'Mac'
            : /Linux/i.test(ua)
              ? 'Linux'
              : 'Device'
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Chrome\//i.test(ua)
      ? 'Chrome'
      : /Firefox\//i.test(ua)
        ? 'Firefox'
        : /Safari\//i.test(ua)
          ? 'Safari'
          : 'browser'
  return `${os} · ${browser}`
}
