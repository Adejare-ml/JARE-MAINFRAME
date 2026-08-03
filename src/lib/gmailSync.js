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
 * Helper to strip HTML tags and decode entities for text pattern parsing
 */
function stripHtml(html) {
  if (!html || typeof html !== 'string') return ''
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n\s*\n/g, '\n')
    .trim()
}

/**
 * Helper to extract and clean email body text from Gmail API payload
 */
function extractEmailBody(payload) {
  if (!payload) return ''

  let rawBody = ''

  if (payload.body && payload.body.data) {
    try {
      rawBody = atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'))
    } catch (e) {
      console.error('Base64 decode error:', e)
    }
  }

  if (!rawBody && payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        try {
          rawBody = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))
          break
        } catch (e) {}
      }
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        try {
          rawBody = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))
          break
        } catch (e) {}
      }
      if (part.parts) {
        const sub = extractEmailBody(part)
        if (sub) {
          rawBody = sub
          break
        }
      }
    }
  }

  if (!rawBody) {
    rawBody = payload.snippet || ''
  }

  return stripHtml(rawBody)
}

/**
 * Format a Date to YYYY/MM/DD for Gmail search query
 */
function formatDateForGmail(date) {
  const d = new Date(date)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

/**
 * Generate a synthetic transaction ID from email content for dedup.
 * Browser-compatible using SubtleCrypto-free approach (simple hash).
 */
function generateSyntheticId(source, amount, dateStr, description) {
  const raw = `${source}|${amount}|${dateStr}|${(description || '').slice(0, 60)}`
  // Simple browser-safe hash
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return 'SYN-' + Math.abs(hash).toString(16).padStart(8, '0') + Date.now().toString(36).slice(-4)
}

/**
 * Extract sender email from Gmail API message payload headers.
 */
function getSenderEmail(payload) {
  if (!payload || !payload.headers) return ''
  const fromHeader = payload.headers.find(h => h.name.toLowerCase() === 'from')
  if (!fromHeader) return ''
  const match = fromHeader.value.match(/<([^>]+)>/)
  return match ? match[1].toLowerCase() : fromHeader.value.trim().toLowerCase()
}

/**
 * Extract domain from email address.
 */
function getDomain(email) {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : ''
}

/**
 * Initiates Google OAuth Token Client flow using Google Identity Services (GIS)
 * Suitable for pure frontend SPA -- no backend redirect URI dependency.
 */
export async function connectGmail(onSuccess) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID

  if (!clientId) {
    const errorMsg = 'VITE_GOOGLE_CLIENT_ID is not configured in environment variables'
    console.error(errorMsg)
    toast.error(errorMsg)
    return { success: false, error: errorMsg }
  }

  try {
    const oauth2 = await loadGsiScript()

    return new Promise((resolve) => {
      const client = oauth2.initTokenClient({
        client_id: clientId,
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
        callback: async (response) => {
          if (response.error) {
            console.error('Google OAuth response error:', response.error)
            toast.error('Google authorization failed: ' + response.error)
            resolve({ success: false, error: response.error })
            return
          }

          const token = response.access_token

          // Query existing integration row
          const { data: existing, error: fetchErr } = await supabase
            .from('integrations')
            .select('*')
            .eq('service', 'gmail')
            .maybeSingle()

          if (fetchErr && fetchErr.code !== 'PGRST116') {
            console.error('Supabase error querying integrations:', fetchErr)
            toast.error('Database error: ' + fetchErr.message)
          }

          let dbErr = null
          // CRITICAL: Do NOT set last_sync at connect time! Keep existing.last_sync or null
          if (existing) {
            const { error } = await supabase
              .from('integrations')
              .update({
                access_token: token,
                status: 'connected',
                last_sync: existing.last_sync || null
              })
              .eq('id', existing.id)
            dbErr = error
          } else {
            const { error } = await supabase
              .from('integrations')
              .insert({
                service: 'gmail',
                access_token: token,
                status: 'connected',
                last_sync: null
              })
            dbErr = error
          }

          if (dbErr) {
            console.error('Supabase error saving Gmail integration:', dbErr)
            toast.error('Failed to save connection: ' + dbErr.message)
            resolve({ success: false, error: dbErr.message })
            return
          }

          toast.success('Gmail connected ✓')
          if (onSuccess) {
            onSuccess({ status: 'connected', last_sync: existing?.last_sync || null })
          }
          resolve({ success: true })
        }
      })

      client.requestAccessToken()
    })
  } catch (err) {
    console.error('Failed to connect Gmail:', err)
    toast.error('Failed to load Google Sign-In: ' + (err.message || err))
    return { success: false, error: err.message }
  }
}

/**
 * Disconnect Gmail integration from Supabase
 * Clears last_sync so reconnecting does a fresh 30-day pull.
 */
export async function disconnectGmail() {
  try {
    const { error } = await supabase
      .from('integrations')
      .delete()
      .eq('service', 'gmail')

    if (error) {
      console.error('Supabase error deleting Gmail integration:', error)
      toast.error('Failed to disconnect Gmail: ' + error.message)
      return false
    }

    toast.success('Gmail disconnected')
    return true
  } catch (err) {
    console.error('Error disconnecting Gmail:', err)
    toast.error('Failed to disconnect Gmail')
    return false
  }
}

/**
 * Perform manual sync of emails from the frontend.
 * Uses dynamic sender list from wallets table.
 */
export async function syncGmailEmails() {
  try {
    // 1. Get integration status
    const { data: integration, error: intErr } = await supabase
      .from('integrations')
      .select('*')
      .eq('service', 'gmail')
      .maybeSingle()

    if (intErr) {
      console.error('Error fetching integration for sync:', intErr)
    }

    if (!integration || (integration.status !== 'connected' && integration.status !== 'active')) {
      toast.info('Please connect Gmail first')
      return 0
    }

    const token = integration.access_token
    if (!token) {
      toast.error('Invalid Gmail access token. Please reconnect.')
      return 0
    }

    // 2. Fetch wallets for dynamic sender list
    const { data: wallets } = await supabase
      .from('wallets')
      .select('*')
      .eq('is_active', true)

    // Build sender → wallet mapping
    const senderMap = new Map()
    const searchSenders = []

    for (const w of (wallets || [])) {
      if (w.alert_sender) {
        const sender = w.alert_sender.trim().toLowerCase()
        senderMap.set(sender, w)
        searchSenders.push(sender)
      }
    }

    // Always include defaults
    const defaults = ['gens@gtbank.com', 'no-reply@opay-nigeria.com']
    for (const s of defaults) {
      if (!searchSenders.includes(s)) searchSenders.push(s)
    }

    // Build Gmail query
    let afterDateStr = ''
    if (integration.last_sync) {
      afterDateStr = formatDateForGmail(integration.last_sync)
    } else {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      afterDateStr = formatDateForGmail(thirtyDaysAgo)
    }

    const fromClauses = searchSenders.map(s => `from:${s}`).join(' OR ')
    const query = `${fromClauses} after:${afterDateStr}`

    // 3. Query Gmail API
    const headers = { Authorization: `Bearer ${token}` }
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
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
      const nowIso = new Date().toISOString()
      await supabase
        .from('integrations')
        .update({ last_sync: nowIso })
        .eq('id', integration.id)
      toast.info('No new transactions')
      return 0
    }

    // Build domain-to-wallet lookup
    const walletByDomain = new Map()
    for (const [sender, wallet] of senderMap.entries()) {
      walletByDomain.set(getDomain(sender), wallet)
    }

    // Fallback wallet lookup by name
    const gtWallet = (wallets || []).find(w => w.name.toLowerCase().includes('gt') || (w.alert_sender && w.alert_sender.toLowerCase().includes('gtbank')))
    const opayWallet = (wallets || []).find(w => w.name.toLowerCase().includes('opay') || (w.alert_sender && w.alert_sender.toLowerCase().includes('opay')))

    let newTxnsCount = 0

    // Process messages
    for (const msg of messages.slice(0, 30)) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers }
      )
      if (!msgRes.ok) continue
      const msgData = await msgRes.json()

      const body = extractEmailBody(msgData.payload) || stripHtml(msgData.snippet || '')
      if (!body || body.length < 20) continue

      const senderEmail = getSenderEmail(msgData.payload)
      const senderDomain = getDomain(senderEmail)

      // Find matching wallet
      let matchedWallet = senderMap.get(senderEmail)
      if (!matchedWallet) matchedWallet = walletByDomain.get(senderDomain)
      if (!matchedWallet) {
        if (senderDomain.includes('gtbank')) matchedWallet = gtWallet
        else if (senderDomain.includes('opay')) matchedWallet = opayWallet
      }

      // Parse using fast-path rules (frontend doesn't do LLM)
      let parsed = null
      if (senderDomain.includes('gtbank.com')) {
        parsed = parseGTBankEmail(body)
        if (parsed && matchedWallet) parsed.wallet_id = matchedWallet.id
      } else if (senderDomain.includes('opay-nigeria.com') || senderDomain.includes('opay.com')) {
        parsed = parseOpayEmail(body)
        if (parsed && matchedWallet) parsed.wallet_id = matchedWallet.id
      } else {
        // Unknown sender: try both parsers based on body content
        const lowerBody = body.toLowerCase()
        if (lowerBody.includes('gtbank') || lowerBody.includes('guaranty trust') || lowerBody.includes('debit transaction')) {
          parsed = parseGTBankEmail(body)
          if (parsed && matchedWallet) parsed.wallet_id = matchedWallet.id
        } else if (lowerBody.includes('opay') || lowerBody.includes('transfer of')) {
          parsed = parseOpayEmail(body)
          if (parsed && matchedWallet) parsed.wallet_id = matchedWallet.id
        }
      }

      if (!parsed || parsed.amount <= 0) continue

      // Generate synthetic ID if parser didn't extract one
      if (!parsed.transaction_id) {
        parsed.transaction_id = generateSyntheticId(
          parsed.source,
          parsed.amount,
          parsed.transaction_date,
          parsed.description
        )
      }

      // Dedup check
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('transaction_id', parsed.transaction_id)
        .eq('source', parsed.source)
        .maybeSingle()

      if (!existing) {
        const { error: insErr } = await supabase.from('transactions').insert(parsed)
        if (!insErr) {
          newTxnsCount++
          if (parsed.available_balance != null && parsed.wallet_id) {
            await supabase.from('wallets').update({
              balance: parsed.available_balance,
              updated_at: new Date().toISOString()
            }).eq('id', parsed.wallet_id)
          }
        } else {
          console.error('Error inserting synced transaction:', insErr)
        }
      }
    }

    // 5. Update last_sync timestamp ONLY after successful sync completes
    const nowIso = new Date().toISOString()
    await supabase
      .from('integrations')
      .update({ last_sync: nowIso })
      .eq('id', integration.id)

    if (newTxnsCount > 0) {
      toast.success(`${newTxnsCount} new transaction${newTxnsCount === 1 ? '' : 's'} synced`)
    } else {
      toast.info('No new transactions')
    }

    return newTxnsCount
  } catch (err) {
    console.error('Gmail sync error:', err)
    toast.error('Sync failed: ' + (err.message || 'Check connection'))
    return 0
  }
}
