import { supabase } from './supabase'
import { parseGTBankEmail } from './parsers/gtbank'
import { parseOpayEmail } from './parsers/opay'
import { toast } from './toast'

/**
 * Dynamically load Google Identity Services (GIS) client script
 */
function loadGsiScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve(window.google.accounts.oauth2)
      return
    }
    const existing = document.getElementById('gsi-client-script')
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google.accounts.oauth2))
      existing.addEventListener('error', reject)
      return
    }
    const script = document.createElement('script')
    script.id = 'gsi-client-script'
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve(window.google.accounts.oauth2)
    script.onerror = (err) => reject(err)
    document.head.appendChild(script)
  })
}

/**
 * Helper to extract email text body from Gmail API payload
 */
function extractEmailBody(payload) {
  if (!payload) return ''

  if (payload.body && payload.body.data) {
    try {
      return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'))
    } catch (e) {
      console.error('Base64 decode error:', e)
    }
  }

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        try {
          return atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))
        } catch (e) {}
      }
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        try {
          return atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))
        } catch (e) {}
      }
      if (part.parts) {
        const sub = extractEmailBody(part)
        if (sub) return sub
      }
    }
  }

  return payload.snippet || ''
}

/**
 * Initiates Google OAuth Token Client flow using Google Identity Services (GIS)
 * Suitable for pure frontend SPA -- no backend redirect URI dependency.
 */
export async function connectGmail(onSuccess) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID

  if (!clientId) {
    toast.error('VITE_GOOGLE_CLIENT_ID is not configured in environment variables')
    return { success: false, error: 'Missing VITE_GOOGLE_CLIENT_ID' }
  }

  try {
    const oauth2 = await loadGsiScript()

    return new Promise((resolve) => {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        callback: async (response) => {
          if (response.error) {
            toast.error('Google authorization failed: ' + response.error)
            resolve({ success: false, error: response.error })
            return
          }

          const token = response.access_token
          const now = new Date().toISOString()

          const { data: existing } = await supabase
            .from('integrations')
            .select('*')
            .eq('service', 'gmail')
            .single()

          if (existing) {
            await supabase.from('integrations').update({
              access_token: token,
              status: 'connected',
              last_sync: existing.last_sync || now
            }).eq('id', existing.id)
          } else {
            await supabase.from('integrations').insert({
              service: 'gmail',
              access_token: token,
              status: 'connected',
              last_sync: now
            })
          }

          toast.success('Gmail connected ✓')
          if (onSuccess) onSuccess()
          resolve({ success: true })
        }
      })

      client.requestAccessToken()
    })
  } catch (err) {
    console.error('Failed to connect Gmail:', err)
    toast.error('Failed to load Google Sign-In')
    return { success: false, error: err.message }
  }
}

/**
 * Perform manual or background sync of emails
 */
export async function syncGmailEmails() {
  try {
    // 1. Get integration status
    const { data: integration, error: intErr } = await supabase
      .from('integrations')
      .select('*')
      .eq('service', 'gmail')
      .single()

    if (intErr || !integration || (integration.status !== 'connected' && integration.status !== 'active')) {
      toast.info('Please connect Gmail first')
      return 0
    }

    const token = integration.access_token
    if (!token) {
      toast.error('Invalid Gmail access token. Please reconnect.')
      return 0
    }

    // 2. Search query with last_sync timestamp filter
    let query = 'from:alerts@gtbank.com OR from:customerservice@opay-inc.com'
    if (integration.last_sync) {
      const lastSyncUnix = Math.floor(new Date(integration.last_sync).getTime() / 1000)
      if (!isNaN(lastSyncUnix) && lastSyncUnix > 0) {
        query += ` after:${lastSyncUnix}`
      }
    }

    // 3. Query Gmail API
    const headers = { Authorization: `Bearer ${token}` }
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`,
      { headers }
    )

    if (res.status === 401) {
      await supabase
        .from('integrations')
        .update({ status: 'disconnected' })
        .eq('id', integration.id)
      toast.error('Gmail session expired. Please reconnect Gmail.')
      return 0
    }

    if (!res.ok) {
      throw new Error(`Gmail API error (${res.status})`)
    }

    const listData = await res.json()
    const messages = listData.messages || []

    if (messages.length === 0) {
      await supabase
        .from('integrations')
        .update({ last_sync: new Date().toISOString() })
        .eq('id', integration.id)
      toast.success('Gmail synced: 0 new transactions found')
      return 0
    }

    // 4. Get wallets mapping
    const { data: wallets } = await supabase.from('wallets').select('*')
    const gtWallet = wallets?.find(w => w.type === 'bank' || w.name.toLowerCase().includes('gt'))
    const opayWallet = wallets?.find(w => w.type === 'mobile' || w.name.toLowerCase().includes('opay'))

    let newTxnsCount = 0

    // Process messages
    for (const msg of messages.slice(0, 20)) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers }
      )
      if (!msgRes.ok) continue
      const msgData = await msgRes.json()

      const body = extractEmailBody(msgData.payload) || msgData.snippet || ''

      let parsed = null
      if (body.includes('GTBank') || body.includes('GeNS') || body.includes('Guaranty Trust') || body.includes('DEBIT transaction')) {
        parsed = parseGTBankEmail(body)
        if (parsed && gtWallet) parsed.wallet_id = gtWallet.id
      } else if (body.includes('Opay') || body.includes('OPay') || body.includes('transfer of')) {
        parsed = parseOpayEmail(body)
        if (parsed && opayWallet) parsed.wallet_id = opayWallet.id
      }

      if (parsed && parsed.transaction_id) {
        // Check duplicate by transaction_id + source
        const { data: existing } = await supabase
          .from('transactions')
          .select('id')
          .eq('transaction_id', parsed.transaction_id)
          .eq('source', parsed.source)
          .maybeSingle()

        if (!existing) {
          // Insert transaction
          const { error: insErr } = await supabase.from('transactions').insert(parsed)
          if (!insErr) {
            newTxnsCount++

            // Update wallet balance if available_balance is provided
            if (parsed.available_balance != null && parsed.wallet_id) {
              await supabase.from('wallets').update({
                balance: parsed.available_balance,
                last_updated: new Date().toISOString()
              }).eq('id', parsed.wallet_id)
            }
          }
        }
      }
    }

    // 5. Update last_sync timestamp
    const nowIso = new Date().toISOString()
    await supabase
      .from('integrations')
      .update({ last_sync: nowIso })
      .eq('id', integration.id)

    toast.success(`${newTxnsCount} new transaction${newTxnsCount === 1 ? '' : 's'} found`)
    return newTxnsCount
  } catch (err) {
    console.error('Gmail sync error:', err)
    toast.error('Sync failed: ' + (err.message || 'Check connection'))
    return 0
  }
}
