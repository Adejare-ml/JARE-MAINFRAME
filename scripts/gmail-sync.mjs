/**
 * Background Gmail transaction sync.
 *
 * Runs on a schedule from .github/workflows/gmail-sync.yml. Reads bank alert
 * emails, parses them into transactions, and writes them to Supabase.
 *
 * All parsing, dedup and routing logic lives in src/lib/sync/, shared with the
 * frontend manual sync. This file is the Node-side wiring: credentials, the
 * Gmail and Supabase calls, and the run report.
 */

import { createClient } from '@supabase/supabase-js'
import { parseGTBankEmail } from '../src/lib/parsers/gtbank.js'
import { parseOpayEmail } from '../src/lib/parsers/opay.js'
import {
  buildSenderQuery,
  listAllMessages,
  extractEmailBody,
  getSenderEmail,
  getMessageDate,
  getDomain,
  generateSyntheticId,
  isSyntheticId,
  validateParsedTransaction,
  buildWalletIndex,
  matchWallet,
  walletSource,
  getParseStrategy,
  nextCursor,
} from '../src/lib/sync/index.js'
import { extractTransaction, hasAnyProvider, LLM_CONFIG } from './llm.mjs'

// ───────────────────────────────────────────────────────────────
// 1. Credentials
// ───────────────────────────────────────────────────────────────

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env

const missingVars = [
  ['GOOGLE_CLIENT_ID', GOOGLE_CLIENT_ID],
  ['GOOGLE_CLIENT_SECRET', GOOGLE_CLIENT_SECRET],
  ['GOOGLE_REFRESH_TOKEN', GOOGLE_REFRESH_TOKEN],
  ['SUPABASE_URL', SUPABASE_URL],
  ['SUPABASE_SERVICE_KEY', SUPABASE_SERVICE_KEY],
]
  .filter(([, value]) => !value)
  .map(([name]) => name)

if (missingVars.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingVars.join(', ')}`)
  process.exit(1)
}

const decodeBase64 = (data) => Buffer.from(data, 'base64').toString('utf-8')

// ───────────────────────────────────────────────────────────────
// 2. Run stats
// ───────────────────────────────────────────────────────────────

const stats = {
  messagesFound: 0,
  messagesProcessed: 0,
  newTransactions: 0,
  duplicatesSkipped: 0,
  parseFailures: 0,
  validationRejects: 0,
  unmatchedSenders: new Set(),
  parsedBy: { rules: 0, ollama: 0, nvidia: 0 },
  walletsUpdated: new Set(),
  truncated: false,
  warnings: [],
  errors: [],
}

// ───────────────────────────────────────────────────────────────
// 3. Google auth
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
    throw new Error(`Failed to refresh Google token (${res.status}): ${await res.text()}`)
  }

  return (await res.json()).access_token
}

// ───────────────────────────────────────────────────────────────
// 4. Parsing
// ───────────────────────────────────────────────────────────────

const RULES_PARSERS = [
  { match: (domain) => domain.includes('gtbank.com'), parse: parseGTBankEmail },
  {
    match: (domain) => domain.includes('opay-nigeria.com') || domain.includes('opay.com'),
    parse: parseOpayEmail,
  },
]

function tryRules(senderDomain, body) {
  for (const { match, parse } of RULES_PARSERS) {
    if (!match(senderDomain)) continue
    const parsed = parse(body)
    if (parsed && parsed.amount > 0) return parsed
  }
  return null
}

/**
 * Parse an email, honouring the wallet's parse strategy.
 *
 * The strategy matters: routing an Opay alert through the rules parser produces
 * a confidently wrong direction, because Opay uses the word "transfer" for
 * money in and money out alike. Those wallets are marked 'llm' and never touch
 * the rules.
 */
async function parseEmail(senderDomain, body, source, strategy) {
  if (strategy !== 'llm') {
    const parsed = tryRules(senderDomain, body)
    if (parsed) {
      stats.parsedBy.rules++
      return { ...parsed, source }
    }
    if (strategy === 'rules') return null
  }

  if (!hasAnyProvider()) return null

  const llm = await extractTransaction(body, (msg) => stats.warnings.push(msg))
  if (!llm) return null

  stats.parsedBy[llm.provider]++

  return {
    ...llm.data,
    source,
    currency: 'NGN',
    // The model reasoned about direction rather than pattern-matching a
    // keyword, but nothing here has been eyeballed yet.
    confidence: 'MEDIUM',
    reviewed: false,
    raw_email: body,
  }
}

// ───────────────────────────────────────────────────────────────
// 5. Main
// ───────────────────────────────────────────────────────────────

async function run() {
  console.log('🚀 Starting background Gmail sync...')
  const startTime = Date.now()

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { disabled: true },
  })

  const { data: integration, error: intErr } = await supabase
    .from('integrations')
    .select('*')
    .eq('service', 'gmail')
    .maybeSingle()
  if (intErr) throw new Error(`Supabase query error on integrations: ${intErr.message}`)

  const { data: wallets, error: wErr } = await supabase.from('wallets').select('*')
  if (wErr) throw new Error(`Failed to fetch wallets: ${wErr.message}`)

  // Senders are data, read from the wallets table, so adding a bank is a
  // Settings edit rather than a deploy.
  const walletIndex = buildWalletIndex(wallets)

  if (walletIndex.senders.length === 0) {
    console.error('❌ No active wallet has an alert_sender set. Add one in Settings → Banks & Wallets.')
    process.exit(1)
  }

  const llmWallets = (wallets || []).filter(
    (w) => w.is_active !== false && w.alert_sender && getParseStrategy(w) === 'llm',
  )
  if (llmWallets.length > 0 && !hasAnyProvider()) {
    // Failing loudly beats running and silently skipping every Opay email.
    console.error(
      `❌ ${llmWallets.map((w) => w.name).join(', ')} require LLM parsing, but neither ` +
        'OLLAMA_API_KEY nor NVIDIA_API_KEY is set. Add one, or change those wallets to ' +
        "parse_strategy 'rules' in Settings.",
    )
    process.exit(1)
  }

  console.log(`👛 ${walletIndex.senders.length} sender(s): ${walletIndex.senders.join(', ')}`)
  if (llmWallets.length > 0) {
    console.log(
      `🤖 LLM parsing for ${llmWallets.map((w) => w.name).join(', ')} ` +
        `(ollama=${LLM_CONFIG.ollama.configured ? LLM_CONFIG.ollama.model : 'off'}, ` +
        `nvidia=${LLM_CONFIG.nvidia.configured ? LLM_CONFIG.nvidia.model : 'off'})`,
    )
  }

  const accessToken = await getAccessToken()
  const headers = { Authorization: `Bearer ${accessToken}` }

  const query = buildSenderQuery(walletIndex.senders, integration?.last_sync || null)
  console.log(`📧 Gmail query: ${query}`)

  const { messages, truncated } = await listAllMessages(query, headers, fetch)
  stats.messagesFound = messages.length
  stats.truncated = truncated

  if (truncated) {
    console.warn(
      `⚠️  Hit the page limit with more messages waiting. Holding last_sync back so ` +
        'the remainder is picked up on the next run.',
    )
  }

  if (messages.length === 0) {
    console.log('✅ No messages matched.')
    // Still record the heartbeat. Returning early meant a quiet day looked
    // exactly like a dead sync, and on a fresh install -- where the
    // integrations row is only created here -- Settings showed "Not connected"
    // while the cron was running perfectly.
    await advanceLastSync(supabase, integration, {
      newestProcessed: null,
      oldestFailed: null,
      truncated,
      loopFailed: false,
    })
    printRunReport(startTime)
    return
  }

  // Balances are collected here and written once at the end. Writing inside the
  // loop meant the last message processed won, and Gmail returns newest first,
  // so the wallet ended up holding the *oldest* balance in the batch.
  const latestBalances = new Map()

  // The cursor needs both ends of the batch.
  //
  // `newest` is where last_sync wants to land; `oldestFailed` is how far it has
  // to be pulled back so a message that failed today gets another attempt
  // tomorrow. Advancing to the *oldest* processed message -- which is what this
  // used to do -- pinned last_sync at the first run's oldest message forever,
  // because every subsequent run re-read the same window and computed the same
  // minimum. The scan then grew until it tripped the page limit permanently.
  let newestProcessed = null
  let oldestFailed = null
  let loopFailed = false

  const markProcessed = (at) => {
    if (at && (!newestProcessed || at > newestProcessed)) newestProcessed = at
  }
  const markFailed = (at) => {
    loopFailed = true
    if (at && (!oldestFailed || at < oldestFailed)) oldestFailed = at
  }

  for (const msg of messages) {
    // Every path out of this block has to call markProcessed or markFailed.
    // A `continue` that records neither used to let last_sync move past a
    // message that was never handled, so it was never seen again.
    let messageDate = null

    try {
      stats.messagesProcessed++

      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers },
      )
      if (!msgRes.ok) {
        // No date to anchor on, so hold the cursor entirely rather than guess.
        stats.errors.push(`Fetch failed for message ${msg.id} (${msgRes.status})`)
        markFailed(null)
        continue
      }
      const msgData = await msgRes.json()
      messageDate = getMessageDate(msgData)

      const body = extractEmailBody(msgData, decodeBase64)
      if (!body || body.length < 20) {
        // Nothing readable in it. Retrying will not help, so let the cursor pass.
        stats.parseFailures++
        markProcessed(messageDate)
        continue
      }

      const senderEmail = getSenderEmail(msgData.payload)
      const wallet = matchWallet(senderEmail, walletIndex)
      if (!wallet) {
        // Gmail matched the query but no wallet claims the address -- usually a
        // bank sending from a second domain. Hold the cursor: adding the wallet
        // in Settings should be enough to pick these up on the next run.
        stats.unmatchedSenders.add(senderEmail || '(no From header)')
        markFailed(messageDate)
        continue
      }

      const source = walletSource(wallet)
      const parsed = await parseEmail(getDomain(senderEmail), body, source, getParseStrategy(wallet))
      if (!parsed) {
        // A transient LLM outage looks exactly like this, so hold the cursor
        // and try again next run rather than losing the transaction.
        stats.parseFailures++
        markFailed(messageDate)
        continue
      }

      const check = validateParsedTransaction({ ...parsed, source, wallet_id: wallet.id })
      if (!check.ok) {
        // The parse succeeded and produced something unusable. That is
        // deterministic, so retrying forever would wedge the cursor.
        stats.validationRejects++
        stats.warnings.push(`Rejected ${source} message ${msg.id}: ${check.reason}`)
        markProcessed(messageDate)
        continue
      }
      for (const warning of check.warnings) stats.warnings.push(`${source}: ${warning}`)

      const txn = check.value
      if (!txn.transaction_id) {
        txn.transaction_id = generateSyntheticId(
          txn.source,
          txn.amount,
          txn.transaction_date,
          txn.description,
        )
      }

      const inserted = await insertTransaction(supabase, txn)
      if (inserted === 'duplicate') {
        stats.duplicatesSkipped++
      } else if (inserted === 'inserted') {
        stats.newTransactions++
        recordBalance(latestBalances, txn)
      }

      markProcessed(messageDate)
    } catch (msgErr) {
      stats.errors.push(`Message ${msg.id}: ${msgErr.message}`)
      markFailed(messageDate)
    }
  }

  await applyBalances(supabase, latestBalances, wallets)
  await advanceLastSync(supabase, integration, {
    newestProcessed,
    oldestFailed,
    truncated,
    loopFailed,
  })

  printRunReport(startTime)
}

/**
 * Insert one transaction idempotently.
 *
 * Two guards, because there are two ways the same transaction can arrive twice:
 *
 * 1. The unique index on (source, transaction_id) -- the database refuses the
 *    second write outright, closing the race between a cron run and a manual
 *    sync that a SELECT-then-INSERT left open.
 * 2. A natural-key lookup for synthetic IDs. Those are derived from the
 *    transaction's content, so any change to the derivation orphans the ones
 *    already stored. Matching on content as well absorbs that.
 */
async function insertTransaction(supabase, txn) {
  if (isSyntheticId(txn.transaction_id)) {
    const { data: existing, error } = await supabase
      .from('transactions')
      .select('id')
      .eq('source', txn.source)
      .eq('transaction_date', txn.transaction_date)
      .eq('amount', txn.amount)
      .eq('description', txn.description)
      .limit(1)

    if (error) throw new Error(`Dedup lookup failed: ${error.message}`)
    if (existing && existing.length > 0) return 'duplicate'
  }

  const { data, error } = await supabase
    .from('transactions')
    .upsert(txn, { onConflict: 'source,transaction_id', ignoreDuplicates: true })
    .select('id')

  if (error) throw new Error(`Insert failed (${txn.transaction_id}): ${error.message}`)

  // ignoreDuplicates returns no row when the unique index rejected the write.
  return data && data.length > 0 ? 'inserted' : 'duplicate'
}

function recordBalance(latestBalances, txn) {
  if (txn.available_balance == null || !txn.wallet_id) return

  const at = `${txn.transaction_date}T${txn.transaction_time}`
  const current = latestBalances.get(txn.wallet_id)
  if (!current || at > current.at) {
    latestBalances.set(txn.wallet_id, { balance: txn.available_balance, at })
  }
}

/**
 * Write each wallet's balance once, from the newest alert that carried one.
 *
 * The comparison has to include the balance already stored, not just the newest
 * within this batch. A delayed alert from 06:30 arriving in the 10am run seeds
 * an empty map and would otherwise overwrite a balance already taken from the
 * 07:59 alert, walking the wallet backwards in time.
 *
 * `balance_as_of` records which alert a balance came from. Where the column is
 * absent the write is skipped rather than guessed at, since overwriting a newer
 * balance with an older one is worse than leaving it alone.
 */
async function applyBalances(supabase, latestBalances, wallets) {
  const byId = new Map((wallets || []).map((w) => [w.id, w]))
  // Detected once from the fetched rows rather than guessed per write: if
  // migration 001 has not run, balance_as_of does not exist and including it
  // makes PostgREST reject every balance update.
  const hasAsOfColumn = (wallets || []).some((w) => 'balance_as_of' in w)

  if (!hasAsOfColumn && latestBalances.size > 0) {
    stats.warnings.push(
      'wallets.balance_as_of is missing (run migration 001). Writing balances without ' +
        'staleness protection -- a delayed older alert can move a balance backwards.',
    )
  }

  for (const [walletId, { balance, at }] of latestBalances) {
    const stored = byId.get(walletId)?.balance_as_of
    if (stored && stored >= at) {
      stats.warnings.push(
        `Wallet ${walletId}: kept stored balance from ${stored}, newer than this batch's ${at}`,
      )
      continue
    }

    const payload = { balance, updated_at: new Date().toISOString() }
    if (hasAsOfColumn) payload.balance_as_of = at

    const { error } = await supabase.from('wallets').update(payload).eq('id', walletId)

    if (error) stats.errors.push(`Balance update failed for wallet ${walletId}: ${error.message}`)
    else stats.walletsUpdated.add(walletId)
  }
}

/**
 * Move the Gmail watermark. The rule itself lives in src/lib/sync/cursor.js so
 * it can be tested; this only reports and writes.
 */
async function advanceLastSync(supabase, integration, run) {
  const { advance, cursor, reason } = nextCursor(run)

  // last_checked is the heartbeat: when a sync last ran, unconditionally.
  // Written even when the cursor is held back, because "did it run" and "how
  // far has it read" are different questions -- Settings was answering the
  // first with the second and reporting a healthy run as "3 days ago".
  const payload = { status: 'connected', last_checked: new Date().toISOString() }

  if (!advance) {
    console.warn(`⚠️  Holding last_sync: ${reason}.`)
  } else {
    console.log(`🔖 last_sync → ${cursor} (${reason})`)
    payload.last_sync = cursor
  }

  const { error } = integration
    ? await supabase.from('integrations').update(payload).eq('id', integration.id)
    : await supabase.from('integrations').insert({ service: 'gmail', ...payload })

  if (error) stats.errors.push(`Failed to update last_sync: ${error.message}`)
}

// ───────────────────────────────────────────────────────────────
// 6. Report
// ───────────────────────────────────────────────────────────────

function printRunReport(startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

  console.log('\n════════════════════════════════════════')
  console.log('  📊 SYNC RUN REPORT')
  console.log('════════════════════════════════════════')
  console.log(`  Duration:            ${elapsed}s`)
  console.log(`  Messages found:      ${stats.messagesFound}${stats.truncated ? ' (TRUNCATED)' : ''}`)
  console.log(`  Messages processed:  ${stats.messagesProcessed}`)
  console.log(`  New transactions:    ${stats.newTransactions}`)
  console.log(`  Duplicates skipped:  ${stats.duplicatesSkipped}`)
  console.log(`  Parse failures:      ${stats.parseFailures}`)
  console.log(`  Validation rejects:  ${stats.validationRejects}`)
  console.log(`  Wallets updated:     ${stats.walletsUpdated.size}`)
  console.log('  ── Parsed by ──')
  console.log(`    Rules:             ${stats.parsedBy.rules}`)
  console.log(`    Ollama:            ${stats.parsedBy.ollama}`)
  console.log(`    NVIDIA:            ${stats.parsedBy.nvidia}`)

  if (stats.unmatchedSenders.size > 0) {
    console.log('  ── Senders with no wallet ──')
    for (const sender of stats.unmatchedSenders) console.log(`    ❔ ${sender}`)
    console.log('     Add these in Settings → Banks & Wallets to capture them.')
  }

  if (stats.warnings.length > 0) {
    console.log('  ── Warnings ──')
    for (const w of stats.warnings.slice(0, 20)) console.log(`    ⚠️  ${w}`)
    if (stats.warnings.length > 20) console.log(`    … and ${stats.warnings.length - 20} more`)
  }

  if (stats.errors.length > 0) {
    console.log('  ── Errors ──')
    for (const e of stats.errors.slice(0, 20)) console.log(`    ❌ ${e}`)
    if (stats.errors.length > 20) console.log(`    … and ${stats.errors.length - 20} more`)
  }

  console.log('════════════════════════════════════════\n')
  console.log(`✅ Synced ${stats.newTransactions} new transactions`)
}

run().catch((err) => {
  console.error('❌ Gmail Sync script failed:', err)
  process.exit(1)
})
