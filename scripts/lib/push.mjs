/**
 * Send one push to every device the owner subscribed (push_subscriptions,
 * migration 031), the way scripts/remind.mjs does: a 404/410 removes the
 * device, anything else marks it failed and it is tried again next time.
 * The endpoint is never logged (it is part of a per-device credential and
 * the Actions log is public).
 *
 * Added after Phase 4 for the Diet check-in; remind.mjs keeps its own copy.
 */
import webpush from 'web-push'
import { toPushPayload } from '../../src/lib/reminders.js'

const TTL_SECONDS = 12 * 60 * 60

export async function pushToOwner(supabase, ownerId, payload, env = process.env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { sent: 0, gone: 0, failed: 0, skipped: 'VAPID keys are not set' }
  const { data, error } = await supabase.from('push_subscriptions').select('id, endpoint, p256dh, auth, user_agent').eq('user_id', ownerId)
  if (error) return { sent: 0, gone: 0, failed: 0, skipped: `push_subscriptions: ${error.message}` }
  if (!data?.length) return { sent: 0, gone: 0, failed: 0, skipped: 'no device is subscribed (Settings -> Reminders)' }

  // The same caps (title, body, bytes) and shape the service worker reads.
  const body = toPushPayload(payload)
  webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:owner@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
  const now = new Date().toISOString()
  const outcome = { sent: 0, gone: 0, failed: 0 }
  for (const row of data) {
    try {
      await webpush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, { TTL: TTL_SECONDS })
      outcome.sent++
      await supabase.from('push_subscriptions').update({ last_used_at: now }).eq('id', row.id)
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        outcome.gone++
        await supabase.from('push_subscriptions').delete().eq('id', row.id)
      } else {
        outcome.failed++
        await supabase.from('push_subscriptions').update({ failed_at: now }).eq('id', row.id)
      }
    }
  }
  return outcome
}
