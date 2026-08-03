import { createClient } from '@supabase/supabase-js'
import { parseGTBankEmail } from '../src/lib/parsers/gtbank.js'
import { parseOpayEmail } from '../src/lib/parsers/opay.js'
import crypto from 'crypto'

// ───────────────────────────────────────────────────────────────
// 1. Verify required environment variables
// ───────────────────────────────────────────────────────────────
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  OLLAMA_API_KEY,
  NVIDIA_API_KEY,
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

// Optional LLM keys
if (!OLLAMA_API_KEY && !NVIDIA_API_KEY) {
  console.warn('⚠️  No LLM API keys configured (OLLAMA_API_KEY, NVIDIA_API_KEY). LLM parsing disabled, will use rules-based parsing only.')
}

// ───────────────────────────────────────────────────────────────
// 2. Run stats for per-run logging
// ───────────────────────────────────────────────────────────────
const stats = {
  messagesFound: 0,
  messagesProcessed: 0,
  newTransactions: 0,
  duplicatesSkipped: 0,
  parseFailures: 0,
  llmCalls: { ollama: 0, nvidia: 0, rulesBased: 0 },
  walletsUpdated: new Set(),
  errors: [],
}

// ───────────────────────────────────────────────────────────────
// 3. Helpers
// ───────────────────────────────────────────────────────────────

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

function formatDateForGmail(date) {
  const d = new Date(date)
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${year}/${month}/${day}`
}

/**
 * Generate a synthetic transaction ID from email content for dedup.
 * Used when the parser cannot extract a transaction_id from the email body.
 */
function generateSyntheticId(source, amount, dateStr, description) {
  const raw = `${source}|${amount}|${dateStr}|${(description || '').slice(0, 60)}`
  return 'SYN-' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * Extract the From header sender email from Gmail message payload.
 */
function getSenderEmail(payload) {
  if (!payload || !payload.headers) return ''
  const fromHeader = payload.headers.find(h => h.name.toLowerCase() === 'from')
  if (!fromHeader) return ''
  // Extract email from "Name <email@domain.com>" or plain "email@domain.com"
  const match = fromHeader.value.match(/<([^>]+)>/)
  return match ? match[1].toLowerCase() : fromHeader.value.trim().toLowerCase()
}

/**
 * Extract the domain from an email address.
 */
function getDomain(email) {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : ''
}

// ───────────────────────────────────────────────────────────────
// 4. LLM Parsing
// ───────────────────────────────────────────────────────────────

const LLM_SYSTEM_PROMPT = `You are a financial email parser. Extract transaction data from bank/fintech notification emails.
Return ONLY valid JSON with these fields:
{
  "type": "debit" or "credit",
  "amount": number (no currency symbol, no commas),
  "currency": "NGN",
  "description": "short description of the transaction",
  "recipient": "name of recipient/sender or null",
  "category": "one of: Feeding / Groceries, Transport, Airtime & Data, Electricity, Generator, Rent, Water, Work Expenses, Courses & Learning, Tools & Software, Equipment, Pharmacy, Hospital / Clinic, Personal Care, Family Support, Social Events, Church / Mosque, Ajo / Esusu, Loan Repayment, Bank Charges, Savings Transfer, Cash Withdrawal, Cash Received, Clothing & Fashion, Entertainment, Dining Out, Subscriptions, Repairs, Miscellaneous, Uncategorized",
  "transaction_date": "YYYY-MM-DD",
  "transaction_time": "HH:MM:SS",
  "transaction_id": "the reference/document number if found, or null",
  "available_balance": number or null
}
If you cannot parse the email, return: {"error": "unparseable"}`

/**
 * Call LLM with Ollama as primary, NVIDIA as fallback.
 * Returns parsed JSON object or null.
 */
async function callLLM(emailBody) {
  const userPrompt = `Parse this bank notification email:\n\n${emailBody.slice(0, 3000)}`

  // Try Ollama first
  if (OLLAMA_API_KEY) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)

      const res = await fetch('https://api.ollama.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OLLAMA_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama3.1',
          messages: [
            { role: 'system', content: LLM_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (res.ok) {
        const data = await res.json()
        const content = data.choices?.[0]?.message?.content
        if (content) {
          const parsed = JSON.parse(content)
          if (!parsed.error) {
            stats.llmCalls.ollama++
            return parsed
          }
        }
      }
    } catch (e) {
      console.warn('⚠️  Ollama call failed:', e.message || e.name)
    }
  }

  // Fallback: NVIDIA
  if (NVIDIA_API_KEY) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20000)

      const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-ai/deepseek-r1',
          messages: [
            { role: 'system', content: LLM_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (res.ok) {
        const data = await res.json()
        const content = data.choices?.[0]?.message?.content
        if (content) {
          // DeepSeek sometimes wraps JSON in markdown code blocks
          const jsonMatch = content.match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            if (!parsed.error) {
              stats.llmCalls.nvidia++
              return parsed
            }
          }
        }
      }
    } catch (e) {
      console.warn('⚠️  NVIDIA call failed:', e.message || e.name)
    }
  }

  return null
}

// ───────────────────────────────────────────────────────────────
// 5. Routing & Parsing Logic
// ───────────────────────────────────────────────────────────────

/**
 * Try fast-path rules-based parsing for known banks.
 * Returns { parsed, source } or null.
 */
function tryFastPath(senderDomain, body) {
  if (senderDomain.includes('gtbank.com')) {
    const parsed = parseGTBankEmail(body)
    if (parsed && parsed.amount > 0) {
      stats.llmCalls.rulesBased++
      return { parsed, source: 'gtbank' }
    }
  }

  if (senderDomain.includes('opay-nigeria.com') || senderDomain.includes('opay.com')) {
    const parsed = parseOpayEmail(body)
    if (parsed && parsed.amount > 0) {
      stats.llmCalls.rulesBased++
      return { parsed, source: 'opay' }
    }
  }

  return null
}

/**
 * Parse email using fast-path first, then LLM fallback.
 * Returns parsed transaction object or null.
 */
async function parseEmail(senderDomain, body, walletSource) {
  // 1. Try fast-path rules for known banks
  const fastResult = tryFastPath(senderDomain, body)
  if (fastResult) return fastResult.parsed

  // 2. LLM fallback
  const llmResult = await callLLM(body)
  if (llmResult && llmResult.amount > 0) {
    return {
      type: llmResult.type || 'debit',
      amount: Number(llmResult.amount) || 0,
      currency: 'NGN',
      source: walletSource || 'email',
      category: llmResult.category || 'Uncategorized',
      description: llmResult.description || '',
      recipient: llmResult.recipient || null,
      available_balance: llmResult.available_balance != null ? Number(llmResult.available_balance) : null,
      transaction_date: llmResult.transaction_date || new Date().toISOString().split('T')[0],
      transaction_time: llmResult.transaction_time || '12:00:00',
      transaction_id: llmResult.transaction_id || null,
      confidence: 'MEDIUM',
      reviewed: false,
      raw_email: body,
    }
  }

  return null
}

// ───────────────────────────────────────────────────────────────
// 6. Main Run
// ───────────────────────────────────────────────────────────────

async function run() {
  console.log('🚀 Starting background Gmail sync...')
  const startTime = Date.now()

  // Initialize Supabase admin client
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { disabled: true }
  })

  const accessToken = await getAccessToken()

  // Fetch integration record
  const { data: integration, error: intErr } = await supabase
    .from('integrations')
    .select('*')
    .eq('service', 'gmail')
    .maybeSingle()

  if (intErr) {
    throw new Error(`Supabase query error on integrations: ${intErr.message}`)
  }

  const lastSync = integration?.last_sync || null

  // ── Fetch wallets with alert_sender for dynamic sender list ──
  const { data: wallets, error: wErr } = await supabase
    .from('wallets')
    .select('*')
    .eq('is_active', true)

  if (wErr) {
    throw new Error(`Failed to fetch wallets: ${wErr.message}`)
  }

  // Build sender → wallet mapping from wallets with alert_sender
  const senderMap = new Map() // senderEmail → wallet
  const searchSenders = []

  for (const w of (wallets || [])) {
    if (w.alert_sender) {
      const sender = w.alert_sender.trim().toLowerCase()
      senderMap.set(sender, w)
      searchSenders.push(sender)
    }
  }

  // Fallback: always include known defaults if no dynamic senders
  const defaultSenders = ['gens@gtbank.com', 'no-reply@opay-nigeria.com']
  if (searchSenders.length === 0) {
    for (const s of defaultSenders) {
      if (!searchSenders.includes(s)) searchSenders.push(s)
    }
  } else {
    // Ensure defaults are included too
    for (const s of defaultSenders) {
      if (!searchSenders.includes(s)) searchSenders.push(s)
    }
  }

  // Build Gmail search query
  let afterDateStr = ''
  if (lastSync) {
    afterDateStr = formatDateForGmail(lastSync)
  } else {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    afterDateStr = formatDateForGmail(thirtyDaysAgo)
  }

  const fromClauses = searchSenders.map(s => `from:${s}`).join(' OR ')
  const query = `${fromClauses} after:${afterDateStr}`
  console.log(`📧 Gmail query: ${query}`)

  const headers = { Authorization: `Bearer ${accessToken}` }
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=100`,
    { headers }
  )

  if (!listRes.ok) {
    const listErrText = await listRes.text()
    throw new Error(`Gmail API messages query failed (${listRes.status}): ${listErrText}`)
  }

  const listData = await listRes.json()
  const messages = listData.messages || []
  stats.messagesFound = messages.length

  if (messages.length === 0) {
    const nowIso = new Date().toISOString()
    if (integration) {
      await supabase.from('integrations').update({ last_sync: nowIso }).eq('id', integration.id)
    }
    console.log('✅ Synced 0 new transactions (no messages found)')
    printRunReport(startTime)
    return
  }

  // ── Also build a fast lookup: wallet by domain or name ──
  const walletByDomain = new Map()
  for (const [sender, wallet] of senderMap.entries()) {
    walletByDomain.set(getDomain(sender), wallet)
  }

  // Fallback wallet lookup by name/type
  const gtWallet = (wallets || []).find(w => w.name.toLowerCase().includes('gt') || (w.alert_sender && w.alert_sender.toLowerCase().includes('gtbank')))
  const opayWallet = (wallets || []).find(w => w.name.toLowerCase().includes('opay') || (w.alert_sender && w.alert_sender.toLowerCase().includes('opay')))

  // Process messages
  for (const msg of messages) {
    try {
      stats.messagesProcessed++

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

      // Find matching wallet for this sender
      let matchedWallet = senderMap.get(senderEmail)
      if (!matchedWallet) {
        matchedWallet = walletByDomain.get(senderDomain)
      }
      if (!matchedWallet) {
        // Fallback: try domain matching to known wallets
        if (senderDomain.includes('gtbank')) matchedWallet = gtWallet
        else if (senderDomain.includes('opay')) matchedWallet = opayWallet
      }

      const walletSource = matchedWallet?.name?.toLowerCase().replace(/\s+/g, '_') || 'email'

      // Parse the email
      const parsed = await parseEmail(senderDomain, body, walletSource)
      if (!parsed || parsed.amount <= 0) {
        stats.parseFailures++
        continue
      }

      // Assign wallet_id
      if (matchedWallet) {
        parsed.wallet_id = matchedWallet.id
      }

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

      if (existing) {
        stats.duplicatesSkipped++
        continue
      }

      // Insert transaction
      const { error: insErr } = await supabase.from('transactions').insert(parsed)
      if (insErr) {
        stats.errors.push(`Insert failed (${parsed.transaction_id}): ${insErr.message}`)
        continue
      }

      stats.newTransactions++

      // Update wallet balance if available_balance provided
      if (parsed.available_balance != null && parsed.wallet_id) {
        await supabase.from('wallets').update({
          balance: parsed.available_balance,
          updated_at: new Date().toISOString()
        }).eq('id', parsed.wallet_id)
        stats.walletsUpdated.add(parsed.wallet_id)
      }

    } catch (msgErr) {
      stats.errors.push(`Message ${msg.id}: ${msgErr.message}`)
    }
  }

  // Update last_sync ONLY after successful sync
  const nowIso = new Date().toISOString()
  if (integration) {
    await supabase.from('integrations').update({ last_sync: nowIso, status: 'connected' }).eq('id', integration.id)
  } else {
    await supabase.from('integrations').insert({ service: 'gmail', status: 'connected', last_sync: nowIso })
  }

  printRunReport(startTime)
}

function printRunReport(startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log('\n════════════════════════════════════════')
  console.log('  📊 SYNC RUN REPORT')
  console.log('════════════════════════════════════════')
  console.log(`  Duration:            ${elapsed}s`)
  console.log(`  Messages found:      ${stats.messagesFound}`)
  console.log(`  Messages processed:  ${stats.messagesProcessed}`)
  console.log(`  New transactions:    ${stats.newTransactions}`)
  console.log(`  Duplicates skipped:  ${stats.duplicatesSkipped}`)
  console.log(`  Parse failures:      ${stats.parseFailures}`)
  console.log(`  Wallets updated:     ${stats.walletsUpdated.size}`)
  console.log('  ── Parsing Provider Usage ──')
  console.log(`    Rules-based:       ${stats.llmCalls.rulesBased}`)
  console.log(`    Ollama LLM:        ${stats.llmCalls.ollama}`)
  console.log(`    NVIDIA LLM:        ${stats.llmCalls.nvidia}`)
  if (stats.errors.length > 0) {
    console.log('  ── Errors ──')
    stats.errors.forEach(e => console.log(`    ❌ ${e}`))
  }
  console.log('════════════════════════════════════════\n')
  console.log(`✅ Synced ${stats.newTransactions} new transactions`)
}

run().catch((err) => {
  console.error('❌ Gmail Sync script failed:', err)
  process.exit(1)
})
