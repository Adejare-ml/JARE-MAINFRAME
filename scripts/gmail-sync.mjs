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
 * Extract email text body from Gmail API message payload
 */
function extractEmailBody(payload) {
  if (!payload) return ''

  if (payload.body && payload.body.data) {
    try {
      return Buffer.from(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
    } catch (e) {}
  }

  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        try {
          return Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
        } catch (e) {}
      }
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        try {
          return Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
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

async function run() {
  console.log('🚀 Starting background Gmail sync...')

  // Initialize Supabase admin client
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // Get fresh Google access token
  const accessToken = await getAccessToken()

  // Read last_sync from integrations table
  const { data: integration, error: intErr } = await supabase
    .from('integrations')
    .select('*')
    .eq('service', 'gmail')
    .maybeSingle()

  if (intErr) {
    throw new Error(`Supabase query error on integrations: ${intErr.message}`)
  }

  const lastSync = integration?.last_sync || null

  // Build Gmail search query
  let query = 'from:alerts@gtbank.com OR from:customerservice@opay-inc.com'
  if (lastSync) {
    const lastSyncUnix = Math.floor(new Date(lastSync).getTime() / 1000)
    if (!isNaN(lastSyncUnix) && lastSyncUnix > 0) {
      query += ` after:${lastSyncUnix}`
    }
  }

  // Fetch matching messages from Gmail
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

  // Get wallets mapping
  const { data: wallets, error: wErr } = await supabase.from('wallets').select('*')
  if (wErr) {
    throw new Error(`Failed to fetch wallets: ${wErr.message}`)
  }

  const gtWallet = wallets?.find(w => w.type === 'bank' || w.name.toLowerCase().includes('gt'))
  const opayWallet = wallets?.find(w => w.type === 'mobile' || w.name.toLowerCase().includes('opay'))

  let newTxnsCount = 0

  // Process messages
  for (const msg of messages) {
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
      // Check for duplicates (transaction_id + source)
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('transaction_id', parsed.transaction_id)
        .eq('source', parsed.source)
        .maybeSingle()

      if (!existing) {
        // Insert transaction
        const { error: insErr } = await supabase.from('transactions').insert(parsed)
        if (insErr) {
          console.error(`Failed to insert transaction ${parsed.transaction_id}:`, insErr.message)
        } else {
          newTxnsCount++

          // Update wallet balance if available_balance is present
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

  // Update last_sync timestamp
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
