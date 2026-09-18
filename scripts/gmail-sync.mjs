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
  directionFromBalance,
  hasReliableDirection,
  BalanceChain,
  sortChronologically,
  applyCategoryOverrides,
  combineConfidence,
  chunk,
  MAX_CORRECTION_EXAMPLES,
  FailureLedger,
} from '../src/lib/sync/index.js'
import { extractTransaction, categorizeBatch, hasAnyProvider, LLM_CONFIG } from './llm.mjs'
import { getAccessToken as refreshGoogleToken } from './google.mjs'
import { assertProgress } from './lib/assertProgress.mjs'

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

/**
 * Whose rows these are.
 *
 * Required, not optional, and that is the whole point. This script writes with
 * the service-role key, which bypasses RLS and has no `auth.uid()` -- so a row
 * it inserts without `user_id` is a row that migration 015's policy makes
 * invisible to you in the app, with no error anywhere. Treating this as
 * optional would turn a missing repository secret into silently vanishing data,
 * which is this project's signature failure.
 *
 * Get it from: select id from auth.users;
 */
const OWNER_USER_ID = process.env.OWNER_USER_ID

const missingVars = [
  ['OWNER_USER_ID', OWNER_USER_ID],
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
  // How each transaction's debit/credit was decided.
  directionBy: { label: 0, balance: 0, noPriorBalance: 0, flatBalance: 0, unresolved: 0 },
  categorizedBy: { ollama: 0, nvidia: 0, none: 0, override: 0 },
  autoAccepted: 0,
  needsReview: 0,
  walletsUpdated: new Set(),
  truncated: false,
  // Messages that exhausted their retries this run and were let past the
  // cursor. Reported loudly: this is the one outcome where the sync stops
  // trying to import something, so it must never be inferred from a silence.
  gaveUp: [],
  warnings: [],
  errors: [],
}

// ───────────────────────────────────────────────────────────────
// 3. Google auth
// ───────────────────────────────────────────────────────────────

async function getAccessToken() {
  // The refresh dance, and the `invalid_grant` remedy it prints, live in
  // scripts/google.mjs now that the day planner needs them too. One copy, so
  // the message that took several silent scheduled failures to work out cannot
  // drift between callers.
  const { accessToken } = await refreshGoogleToken({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    refreshToken: GOOGLE_REFRESH_TOKEN,
  })
  return accessToken
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
 * Parse an email and settle its direction.
 *
 * Direction is resolved in order of how much the answer can be trusted:
 *
 *   1. An explicit DEBIT/CREDIT label the parser read (GTBank, Zenith, Polaris).
 *   2. Balance movement -- the balance this alert states, against the balance
 *      before it. Subtraction, not inference, so it outranks the model.
 *   3. The LLM, for the cases arithmetic cannot reach: the first alert ever
 *      seen for a wallet, and a balance that did not move.
 *
 * Rules run for every wallet now, including ones marked 'llm'. An Opay alert
 * yields a perfectly good amount, date, reference and balance -- only its
 * *direction* was ever untrustworthy, and step 2 supplies that. The strategy
 * still governs whether the expensive per-email LLM extraction may run.
 *
 * @returns {Promise<object|null>} parsed transaction, or null
 */
async function parseEmail(senderDomain, body, source, strategy, chain, walletId) {
  const priorBalance = chain.priorFor(walletId)
  let parsed = tryRules(senderDomain, body)

  if (parsed) {
    stats.parsedBy.rules++
    parsed = { ...parsed, source }
  } else if (strategy === 'rules' || !hasAnyProvider()) {
    // Rules could not read this format and we are not allowed to (or cannot)
    // ask the model.
    return null
  } else {
    const llm = await extractTransaction(body, (msg) => stats.warnings.push(msg))
    if (!llm) return null

    stats.parsedBy[llm.provider]++
    parsed = {
      ...llm.data,
      source,
      currency: 'NGN',
      // Inference, not a stated label -- so balance movement below still gets
      // first refusal on the direction.
      direction_source: 'llm',
      // LOW, not MEDIUM. This is the value the row is *born* with, moments
      // before categorization overwrites it via combineConfidence -- which
      // returns only 'HIGH' or 'LOW'. So did every other producer in the
      // codebase; 'MEDIUM' was a third value nothing generated and nothing
      // read, and `transactions_confidence_check` in the live schema rejects
      // it outright.
      //
      // The cost of that one word: every LLM-parsed email ever fetched failed
      // to insert. Thirty-two in a single run, each with the same 23514, while
      // the report printed a cheerful "Synced 0 new transactions" -- because a
      // sync that finds nothing and a sync whose every insert bounces both end
      // at zero. Rules-parsed wallets were unaffected, which is why Stanbic
      // imported for months and GTBank and Opay never once did.
      confidence: 'LOW',
      raw_email: body,
    }
  }

  // Tracked separately from `confidence`, which describes the category. A
  // GTBank alert can state DEBIT unambiguously while its category is a guess;
  // those are two different questions and conflating them meant every such
  // transaction landed in the review queue.
  let directionConfidence

  if (hasReliableDirection(parsed)) {
    stats.directionBy.label++
    directionConfidence = 'HIGH'
  } else {
    const fromBalance = directionFromBalance(parsed.available_balance, priorBalance)

    if (fromBalance) {
      stats.directionBy.balance++
      parsed = { ...parsed, type: fromBalance.type }
      directionConfidence = 'HIGH'
    } else if (parsed.available_balance == null) {
      // No balance stated, so arithmetic cannot help. The model's inference is
      // the best available; a keyword guess is not.
      stats.directionBy.unresolved++
      directionConfidence = parsed.direction_source === 'llm' ? 'MEDIUM' : 'LOW'
    } else if (priorBalance == null) {
      // First alert for this wallet: nothing to compare against yet. The next
      // one will have this alert's balance to work from.
      stats.directionBy.noPriorBalance++
      directionConfidence = parsed.direction_source === 'llm' ? 'MEDIUM' : 'LOW'
    } else {
      // Balance did not move -- a reversal, or two alerts for one event.
      stats.directionBy.flatBalance++
      directionConfidence = parsed.direction_source === 'llm' ? 'MEDIUM' : 'LOW'
    }
  }

  return { ...parsed, directionConfidence }
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

  // Loaded once and shown to the model as examples of how this user files
  // things, so categorization drifts toward their habits over time.
  const corrections = hasAnyProvider() ? await loadCorrections(supabase) : []
  if (corrections.length > 0) {
    console.log(`🧠 ${corrections.length} past correction(s) will guide categorization`)
  }

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

  // How many times each message has already failed, from previous runs. Loaded
  // before the cursor helpers because they close over it -- a message that has
  // exhausted its retries is let past the watermark rather than pinning it.
  //
  // A missing table degrades to the old behaviour (retry forever) rather than
  // failing the run: migration 008 may not have been applied yet, and refusing
  // to sync over a bookkeeping table would be a worse outage than the leak it
  // fixes.
  const ledger = await loadFailureLedger(supabase)

  const markProcessed = (at) => {
    if (at && (!newestProcessed || at > newestProcessed)) newestProcessed = at
  }
  const markFailed = (at) => {
    loopFailed = true
    if (at && (!oldestFailed || at < oldestFailed)) oldestFailed = at
  }

  /**
   * A retryable failure: hold the cursor for it, unless it has now failed often
   * enough that holding the cursor is costing more than the message is worth.
   *
   * Giving up is not the same as losing the transaction. The message stays in
   * Gmail, the row is recorded in sync_failures with its date and error, and
   * the run report names it. What stops is the re-reading -- which is the whole
   * expense, and which was buying nothing on the sixth identical attempt.
   */
  const holdOrGiveUp = (messageId, at, reason) => {
    if (!messageId) {
      // No id to count against, so this cannot be bounded. Hold, as before.
      markFailed(at)
      return
    }

    const { attempts, giveUp } = ledger.recordFailure(messageId, {
      reason,
      date: at,
      source: null,
    })

    if (giveUp) {
      stats.gaveUp.push({ messageId, date: at, reason, attempts })
      markProcessed(at)
    } else {
      markFailed(at)
    }
  }

  // ── Phase 1: fetch every message body ──
  //
  // Fetching and processing used to happen in one pass, in Gmail's newest-first
  // order. A balance chain needs the opposite: each alert has to be compared
  // against the one before it, so everything is fetched, sorted oldest-first,
  // and only then processed.
  const fetched = []

  for (const msg of messages) {
    try {
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
      fetched.push(await msgRes.json())
    } catch (fetchErr) {
      stats.errors.push(`Fetch failed for message ${msg.id}: ${fetchErr.message}`)
      markFailed(null)
    }
  }

  const ordered = sortChronologically(fetched)

  // Seeded from each wallet's stored balance, then advanced by every alert that
  // states one -- including duplicates that are not inserted, so the re-scan
  // overlap does not break the chain.
  const chain = new BalanceChain(wallets)

  // Transactions that were inserted, held for the categorization pass.
  const pending = []
  const willCategorize = hasAnyProvider()

  // ── Phase 2: process in chronological order ──
  for (const msgData of ordered) {
    // Every path out of this block has to call markProcessed or markFailed.
    // A `continue` that records neither used to let last_sync move past a
    // message that was never handled, so it was never seen again.
    let messageDate = null

    try {
      stats.messagesProcessed++
      messageDate = getMessageDate(msgData)
      const msgId = msgData.id

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
        holdOrGiveUp(msgId, messageDate, `no wallet claims ${senderEmail || 'this sender'}`)
        continue
      }

      const source = walletSource(wallet)
      const parsed = await parseEmail(
        getDomain(senderEmail),
        body,
        source,
        getParseStrategy(wallet),
        chain,
        wallet.id,
      )

      // Whatever happens to this row, the balance it reported advances the
      // chain. A duplicate is not inserted but still moves the wallet forward,
      // which is what makes the next alert's comparison correct.
      if (parsed?.available_balance != null) chain.observe(wallet.id, parsed.available_balance)

      if (!parsed) {
        // A transient LLM outage looks exactly like this, so hold the cursor
        // and try again next run rather than losing the transaction -- but only
        // for a bounded number of runs. Two Opay alerts that no model could read
        // held the watermark at a fixed date indefinitely, and every run after
        // them re-read a window that grew with the calendar.
        stats.parseFailures++
        holdOrGiveUp(msgId, messageDate, 'no parser or model could read this email')
        continue
      }

      const check = validateParsedTransaction({ ...parsed, source, wallet_id: wallet.id })
      if (!check.ok) {
        // The parse succeeded and produced something unusable. That is
        // deterministic, so retrying forever would wedge the cursor.
        stats.validationRejects++
        stats.warnings.push(`Rejected ${source} message ${msgId}: ${check.reason}`)
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

      // A confident *direction* is not a settled transaction. Categorization
      // runs after this loop, so anything awaiting it goes in unreviewed and is
      // auto-accepted later only if its category is settled too. Without this,
      // a GTBank alert with an explicit DEBIT label would be marked reviewed
      // while still uncategorized, and never surface.
      if (willCategorize) txn.reviewed = false

      const inserted = await insertTransaction(supabase, txn)
      if (inserted === 'duplicate') {
        stats.duplicatesSkipped++
      } else if (inserted === 'inserted') {
        stats.newTransactions++
        recordBalance(latestBalances, txn)
        // Categorized in batches after the loop rather than one call per email.
        pending.push({ txn, wallet, directionConfidence: parsed.directionConfidence })
      }

      // Handled cleanly. Drop any failure history: an outage that has since
      // resolved should leave no trace, or the table fills with problems that
      // no longer exist and stops being worth reading.
      ledger.recordSuccess(msgData.id)
      markProcessed(messageDate)
    } catch (msgErr) {
      stats.errors.push(`Message ${msgData?.id || 'unknown'}: ${msgErr.message}`)
      holdOrGiveUp(msgData?.id, messageDate, msgErr.message)
    }
  }

  await flushFailureLedger(supabase, ledger)

  await categorizeInserted(supabase, pending, corrections)

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
    // The owner is stamped here rather than at every call site, so a new
    // caller cannot forget it. Without it, 015's policy makes the row
    // invisible in the app while this script reports it inserted.
    .upsert({ ...txn, user_id: OWNER_USER_ID }, { onConflict: 'source,transaction_id', ignoreDuplicates: true })
    .select('id')

  if (error) throw new Error(`Insert failed (${txn.transaction_id}): ${error.message}`)

  // ignoreDuplicates returns no row when the unique index rejected the write.
  return data && data.length > 0 ? 'inserted' : 'duplicate'
}

/**
 * Load the user's recent manual category corrections, to show the model as
 * examples of how this person actually files things.
 *
 * Non-fatal: categorization without examples is still categorization, and a
 * missing table (migration 005 not yet run) must not stop the sync.
 */
async function loadCorrections(supabase) {
  const { data, error } = await supabase
    .from('category_corrections')
    .select('recipient, description_snippet, corrected_category')
    .order('created_at', { ascending: false })
    .limit(MAX_CORRECTION_EXAMPLES)

  if (error) {
    stats.warnings.push(`Could not load past corrections: ${error.message}`)
    return []
  }
  return data || []
}

/**
 * Categorize and explain everything that was inserted, in batches.
 *
 * Runs after the insert loop so it can group ten transactions per request
 * rather than one per email. Each result is written back, and the deterministic
 * overrides (savings inflow, bank charge, ATM) are applied on top of whatever
 * the model said.
 *
 * A transaction whose category is settled and whose direction is settled is
 * marked reviewed and never reaches the review queue. Everything else does,
 * carrying the model's best guess and its reasoning so confirming it is one tap.
 */
async function categorizeInserted(supabase, pending, corrections) {
  if (pending.length === 0) return

  for (const batch of chunk(pending)) {
    const items = batch.map(({ txn, wallet }) => ({
      id: txn.transaction_id,
      type: txn.type,
      amount: txn.amount,
      description: txn.description,
      recipient: txn.recipient,
      walletName: wallet?.name,
    }))

    let results
    let provider = null
    try {
      const outcome = await categorizeBatch(items, corrections, (msg) => stats.warnings.push(msg))
      results = outcome.results
      provider = outcome.provider
    } catch (err) {
      // categorizeBatch is written not to throw, but a batch of ten must never
      // be able to take the sync down even if that changes.
      stats.warnings.push(`Categorization batch failed: ${err.message}`)
      results = items.map((i) => ({ id: i.id, category: 'Uncategorized', explanation: null, confidence: 'LOW', known: false }))
    }

    if (provider) stats.categorizedBy[provider] += batch.length
    else stats.categorizedBy.none += batch.length

    const byId = new Map(results.map((r) => [String(r.id), r]))

    for (const { txn, wallet, directionConfidence } of batch) {
      const result = byId.get(String(txn.transaction_id))

      const override = applyCategoryOverrides(
        { ...txn, category: result?.category || 'Uncategorized' },
        wallet,
      )
      if (override.reason) stats.categorizedBy.override++

      const confidence = combineConfidence({
        directionConfidence,
        categoryConfidence: result?.confidence,
        categoryKnown: result?.known,
      })
      // An override is a rule about the account, not a guess, so it settles the
      // category half on its own.
      const finalConfidence = override.reason && directionConfidence === 'HIGH' ? 'HIGH' : confidence
      const reviewed = finalConfidence === 'HIGH'

      if (reviewed) stats.autoAccepted++
      else stats.needsReview++

      const explanation = override.reason
        ? `${result?.explanation || 'Categorized by rule'} (${override.reason})`
        : result?.explanation || null

      const { error } = await supabase
        .from('transactions')
        .update({
          category: override.category,
          explanation,
          confidence: finalConfidence,
          reviewed,
        })
        .eq('source', txn.source)
        .eq('transaction_id', txn.transaction_id)

      if (error) {
        stats.errors.push(`Categorization write failed (${txn.transaction_id}): ${error.message}`)
      }
    }
  }
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
 * Load the per-message failure counts that let the cursor give up eventually.
 *
 * Degrades to an empty ledger -- meaning "retry forever", the behaviour before
 * migration 008 -- if the table is not there. That is the honest fallback: an
 * un-applied migration should cost efficiency, not transactions.
 */
async function loadFailureLedger(supabase) {
  const { data, error } = await supabase
    .from('sync_failures')
    .select('message_id, attempts, source, message_date, last_error')

  if (error) {
    // 42P01 undefined_table, PGRST205 unknown table in the schema cache.
    const missing =
      error.code === '42P01' ||
      error.code === 'PGRST205' ||
      /relation .* does not exist|could not find the table/i.test(error.message || '')

    if (missing) {
      console.warn(
        '⚠️  sync_failures table not found -- run migration 008. Failed messages ' +
          'will be retried indefinitely and can pin last_sync.',
      )
    } else {
      stats.warnings.push(`Could not read sync_failures: ${error.message}`)
    }
    return new FailureLedger([])
  }

  return new FailureLedger(data || [])
}

/**
 * Write back what this run learned. Never fatal: a sync that imported real
 * transactions must not be reported as failed because its bookkeeping did not
 * save.
 */
async function flushFailureLedger(supabase, ledger) {
  const writes = ledger.pendingWrites()
  const deletes = ledger.pendingDeletes()

  if (writes.length > 0) {
    const { error } = await supabase
      .from('sync_failures')
      .upsert(writes.map((w) => ({ ...w, user_id: OWNER_USER_ID })), { onConflict: 'message_id' })
    if (error) stats.warnings.push(`Could not record sync failures: ${error.message}`)
  }

  if (deletes.length > 0) {
    const { error } = await supabase.from('sync_failures').delete().in('message_id', deletes)
    if (error) stats.warnings.push(`Could not clear resolved sync failures: ${error.message}`)
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
    : await supabase.from('integrations').insert({ service: 'gmail', user_id: OWNER_USER_ID, ...payload })

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
  console.log(`  Gave up on:          ${stats.gaveUp.length}`)
  console.log(`  Validation rejects:  ${stats.validationRejects}`)
  console.log(`  Wallets updated:     ${stats.walletsUpdated.size}`)
  console.log(`  Auto-accepted:       ${stats.autoAccepted}`)
  console.log(`  Needs review:        ${stats.needsReview}`)
  console.log('  ── Parsed by ──')
  console.log(`    Rules:             ${stats.parsedBy.rules}`)
  console.log(`    Ollama:            ${stats.parsedBy.ollama}`)
  console.log(`    NVIDIA:            ${stats.parsedBy.nvidia}`)
  console.log('  ── Direction decided by ──')
  console.log(`    Bank label:        ${stats.directionBy.label}`)
  console.log(`    Balance movement:  ${stats.directionBy.balance}`)
  console.log(`    No prior balance:  ${stats.directionBy.noPriorBalance}`)
  console.log(`    Balance unchanged: ${stats.directionBy.flatBalance}`)
  console.log(`    No balance stated: ${stats.directionBy.unresolved}`)
  console.log('  ── Categorized by ──')
  console.log(`    Ollama:            ${stats.categorizedBy.ollama}`)
  console.log(`    NVIDIA:            ${stats.categorizedBy.nvidia}`)
  console.log(`    Unavailable:       ${stats.categorizedBy.none}`)
  console.log(`    Rule overrides:    ${stats.categorizedBy.override}`)

  if (stats.unmatchedSenders.size > 0) {
    console.log('  ── Senders with no wallet ──')
    for (const sender of stats.unmatchedSenders) console.log(`    ❔ ${sender}`)
    console.log('     Add these in Settings → Banks & Wallets to capture them.')
  }

  // The one outcome where the sync stops trying to import a real email, so it
  // is named rather than counted. Each of these is a transaction that will not
  // appear in the ledger unless it is logged by hand.
  if (stats.gaveUp.length > 0) {
    console.log('  ── Gave up after repeated failures ──')
    for (const g of stats.gaveUp) {
      console.log(`    🛑 ${g.date || 'unknown date'} (${g.attempts} attempts): ${g.reason}`)
      console.log(`       https://mail.google.com/mail/u/0/#all/${g.messageId}`)
    }
    console.log('     These no longer hold last_sync back. Log them manually if')
    console.log('     they matter, or fix the parser and delete their rows from')
    console.log('     sync_failures to have them retried.')
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

  // Printed above, but never turned into an exit code until now: a batch of
  // errors sat in the log while `if: failure()` in the workflow only ever
  // looks at the exit code, so a run that hit every single one of these still
  // read green in Actions.
  assertProgress([
    { ok: stats.errors.length === 0, reason: `${stats.errors.length} error(s) during this run (see above)` },
  ])
}

run().catch((err) => {
  console.error('❌ Gmail Sync script failed:', err)
  process.exit(1)
})
