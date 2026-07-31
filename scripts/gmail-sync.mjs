import { createClient } from '@supabase/supabase-js'
import { parseGTBankEmail } from '../src/lib/parsers/gtbank.js'
import { parseOpayEmail } from '../src/lib/parsers/opay.js'

// 1. Verify required environment variables
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env

const missingVars = []
if (!GOOGLE_CLIENT_ID) missingVars.push('GOOGLE_CLIENT_ID')
if (!GOOGLE_CLIENT_SECRET) missingVars.push('GOOGLE_CLIENT_SECRET')
if (!GOOGLE_REFRESH_TOKEN) missingVars.push('GOOGLE_REFRESH_TOKEN')
if (!SUPABASE_URL) missingVars.push('SUPABASE_URL')
if (!SUPABASE_SERVICE_KEY) missingVars.push('SUPABASE_SERVICE_KEY')

if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
  process.exit(1)
}

/**
 * Exchange refresh token for fresh access token
 */
async function getAccessToken() {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Failed to refresh Google token (${res.status}): ${errText}`)
  }

  const data = await res.json()
  return data.access_token
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
 * Helper to extract email text body from Gmail API payload
 */
function extractEmailBody(payload) {
  if (!payload) return ''

  let rawBody = ''

  if (payload.body && payload.body.data) {
    try {
      rawBody = Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    } catch (e) {}
  }

  if (!rawBody && payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        try {
          rawBody = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
          break
        } catch (e) {}
      }
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        try {
          rawBody = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
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

async function run() {
  console.log('🚀 Starting background Gmail sync...')

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const accessToken = await getAccessToken()

  const { data: integration, error: intErr } = await supabase
    .from('integrations')
    .select('*')
    .eq('service', 'gmail')
    .maybeSingle()

  if (intErr) {
    throw new Error(`Supabase query error on integrations: ${intErr.message}`)
  }

  const lastSync = integration?.last_sync || null

  // Build query with senders & 30-day lookback window if last_sync is null
  let afterDateStr = ''
  if (lastSync) {
    afterDateStr = formatDateForGmail(lastSync)
  } else {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    afterDateStr = formatDateForGmail(thirtyDaysAgo)
  }

  const query = `from:GeNS@gtbank.com OR from:no-reply@opay-nigeria.com after:${afterDateStr}`

  const headers = { Authorization: `Bearer ${accessToken}` }
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}`,
    { headers }
  )

  if (!listRes.ok) {
    const listErrText = await listRes.text()
    throw new Error(`Gmail API messages query failed (${listRes.status}): ${listErrText}`)
  }

  const listData = await listRes.json()
  const messages = listData.messages || []

  if (messages.length === 0) {
    const nowIso = new Date().toISOString()
    if (integration) {
      await supabase.from('integrations').update({ last_sync: nowIso }).eq('id', integration.id)
    }
    console.log('Synced 0 new transactions')
    return
  }

  const { data: wallets, error: wErr } = await supabase.from('wallets').select('*')
  if (wErr) {
    throw new Error(`Failed to fetch wallets: ${wErr.message}`)
  }

  const gtWallet = wallets?.find(w => w.type === 'bank' || w.name.toLowerCase().includes('gt'))
  const opayWallet = wallets?.find(w => w.type === 'mobile' || w.name.toLowerCase().includes('opay'))

  let newTxnsCount = 0

  for (const msg of messages) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers }
    )
    if (!msgRes.ok) continue
    const msgData = await msgRes.json()

    const body = extractEmailBody(msgData.payload) || stripHtml(msgData.snippet || '')

    let parsed = null
    const lowerBody = body.toLowerCase()

    if (lowerBody.includes('gtbank') || lowerBody.includes('gens') || lowerBody.includes('guaranty trust') || lowerBody.includes('debit transaction')) {
      parsed = parseGTBankEmail(body)
      if (parsed && gtWallet) parsed.wallet_id = gtWallet.id
    } else if (lowerBody.includes('opay') || lowerBody.includes('transfer of')) {
      parsed = parseOpayEmail(body)
      if (parsed && opayWallet) parsed.wallet_id = opayWallet.id
    }

    if (parsed && parsed.transaction_id) {
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('transaction_id', parsed.transaction_id)
        .eq('source', parsed.source)
        .maybeSingle()

      if (!existing) {
        const { error: insErr } = await supabase.from('transactions').insert(parsed)
        if (insErr) {
          console.error(`Failed to insert transaction ${parsed.transaction_id}:`, insErr.message)
        } else {
          newTxnsCount++

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

  // Update last_sync ONLY after successful sync
  const nowIso = new Date().toISOString()
  if (integration) {
    await supabase.from('integrations').update({ last_sync: nowIso, status: 'connected' }).eq('id', integration.id)
  } else {
    await supabase.from('integrations').insert({ service: 'gmail', status: 'connected', last_sync: nowIso })
  }

  console.log(`Synced ${newTxnsCount} new transactions`)
}

run().catch((err) => {
  console.error('❌ Gmail Sync script failed:', err)
  process.exit(1)
})
