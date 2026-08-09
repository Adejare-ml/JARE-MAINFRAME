import { supabase } from './supabase'
import { hasColumn } from './schema'
import { parseGTBankEmail } from './parsers/gtbank'
import { parseOpayEmail } from './parsers/opay'
import { toast } from './toast'
import {
  buildSenderQuery,
  listAllMessages,
  extractEmailBody,
  getSenderEmail,
  getDomain,
  generateSyntheticId,
  isSyntheticId,
  validateParsedTransaction,
  buildWalletIndex,
  matchWallet,
  walletSource,
  getParseStrategy,
  BalanceChain,
  sortChronologically,
  directionFromBalance,
  hasReliableDirection,
} from './sync'

/**
 * Manual "Sync now" from Settings.
 *
 * Shares all its parsing, dedup and routing with the background Action via
 * ./sync -- these used to be two copies that drifted apart, and every bug that
 * produced lived in the gap between them.
 *
 * Two deliberate differences remain.
 *
 * Categories are left to the background sync. Categorization needs a model, and
 * calling one from the browser would mean shipping an API key in the bundle, so
 * transactions logged here arrive Uncategorized at LOW confidence and wait in
 * the review queue. Direction, though, is now settled locally by balance
 * movement -- which is arithmetic, not inference -- so Opay alerts no longer
 * have to be skipped entirely.
 *
 * And this path is stateless: it scans a fixed recent window and never writes
 * `last_sync`. The two paths share one `integrations` row but have different
 * capabilities, so a shared cursor is wrong by construction -- a manual sync
 * that saw only Opay mail used to skip it all, then advance the cursor past it,
 * and the cron never saw those emails again. Inserts are idempotent, so
 * re-scanning the same window costs nothing but a few requests.
 */

const decodeBase64 = (data) => atob(data)

/** How far back a manual sync looks. Bounded on purpose: this runs in a tab on
 *  mobile data, against a token that expires in about an hour. */
const MANUAL_SYNC_DAYS = 7

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
 * Initiates Google OAuth Token Client flow using Google Identity Services (GIS)
 * Suitable for pure frontend SPA -- no backend redirect URI dependency.
 *
 * Note: this yields a ~60-minute access token and no refresh token, so manual
 * sync needs periodic reconnection. The background Action holds a refresh token
 * and is the durable path.
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
          // Do NOT set last_sync at connect time -- that would skip every email
          // between the previous sync and now.
          if (existing) {
            const { error } = await supabase
              .from('integrations')
              .update({
                access_token: token,
                status: 'connected',
                last_sync: existing.last_sync || null,
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
                last_sync: null,
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
        },
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
 * Disconnect Gmail integration from Supabase.
 * Clears last_sync so reconnecting does a fresh 30-day pull.
 */
export async function disconnectGmail() {
  try {
    const { error } = await supabase.from('integrations').delete().eq('service', 'gmail')

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
 * Parse an email with the rules parsers. The frontend has no LLM, so wallets
 * that need one are filtered out before we get here.
 */
function parseWithRules(senderDomain, body) {
  if (senderDomain.includes('gtbank.com')) return parseGTBankEmail(body)
  if (senderDomain.includes('opay-nigeria.com') || senderDomain.includes('opay.com')) {
    return parseOpayEmail(body)
  }
  return null
}

/**
 * Insert one transaction idempotently. Mirrors the background sync: the unique
 * index on (source, transaction_id) is the real guard, plus a natural-key
 * lookup for synthetic IDs, which are derived from content and so change if the
 * derivation ever does.
 *
 * @returns {'inserted'|'duplicate'}
 */
async function insertTransaction(txn) {
  if (isSyntheticId(txn.transaction_id)) {
    const { data: existing, error } = await supabase
      .from('transactions')
      .select('id')
      .eq('source', txn.source)
      .eq('transaction_date', txn.transaction_date)
      .eq('amount', txn.amount)
      .eq('description', txn.description)
      .limit(1)

    if (error) throw new Error(error.message)
    if (existing && existing.length > 0) return 'duplicate'
  }

  // Reads are not the only thing a missing column breaks: writing `explanation`
  // to a database without it fails every insert, so a manual sync would import
  // nothing and say so in a Postgres dialect. Drop the field rather than the
  // transaction -- the row itself is what matters, and the explanation can be
  // backfilled by the scheduled sync once the migration is run.
  const payload = { ...txn }
  if (!hasColumn('transactions.explanation')) delete payload.explanation

  const { data, error } = await supabase
    .from('transactions')
    .upsert(payload, { onConflict: 'source,transaction_id', ignoreDuplicates: true })
    .select('id')

  if (error) throw new Error(error.message)
  return data && data.length > 0 ? 'inserted' : 'duplicate'
}

/**
 * Perform a manual sync of emails from the frontend.
 * @returns {Promise<number>} count of newly inserted transactions
 */
export async function syncGmailEmails() {
  try {
    const { data: integration, error: intErr } = await supabase
      .from('integrations')
      .select('*')
      .eq('service', 'gmail')
      .maybeSingle()

    if (intErr) console.error('Error fetching integration for sync:', intErr)

    if (!integration || (integration.status !== 'connected' && integration.status !== 'active')) {
      toast.info('Please connect Gmail first')
      return 0
    }

    const token = integration.access_token
    if (!token) {
      toast.error('Invalid Gmail access token. Please reconnect.')
      return 0
    }

    const { data: wallets, error: walletsError } = await supabase.from('wallets').select('*')
    if (walletsError) {
      // Dropping this error made a permissions or network failure report as
      // "No wallet has an alert sender set yet" -- the wrong diagnosis.
      toast.error('Could not load wallets: ' + walletsError.message)
      return 0
    }
    const walletIndex = buildWalletIndex(wallets)

    if (walletIndex.senders.length === 0) {
      toast.info('No wallet has an alert sender set yet')
      return 0
    }

    // Deliberately not integration.last_sync -- see the note at the top of this
    // file. A fixed window keeps this path stateless and bounds the work.
    const since = new Date(Date.now() - MANUAL_SYNC_DAYS * 24 * 60 * 60 * 1000)

    const headers = { Authorization: `Bearer ${token}` }
    const query = buildSenderQuery(walletIndex.senders, since)

    let messages = []
    let truncated = false
    try {
      const result = await listAllMessages(query, headers, fetch)
      messages = result.messages
      truncated = result.truncated
    } catch (err) {
      if (err.status === 401) {
        await supabase.from('integrations').update({ status: 'disconnected' }).eq('id', integration.id)
        toast.error('Gmail session expired. Please reconnect Gmail.')
        return 0
      }
      throw err
    }

    if (messages.length === 0) {
      toast.info('No new transactions')
      return 0
    }

    const latestBalances = new Map()
    let newTxnsCount = 0
    let skippedNeedingLlm = 0

    // Fetch everything first, then process oldest-first. Balance movement needs
    // each alert compared against the one before it, and Gmail lists newest
    // first.
    const fetched = []
    for (const msg of messages) {
      try {
        const msgRes = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          { headers },
        )
        if (msgRes.ok) fetched.push(await msgRes.json())
      } catch (fetchErr) {
        console.error('Error fetching message:', fetchErr)
      }
    }

    const chain = new BalanceChain(wallets)

    for (const msgData of sortChronologically(fetched)) {
      try {
        const body = extractEmailBody(msgData, decodeBase64)
        if (!body || body.length < 20) continue

        const senderEmail = getSenderEmail(msgData.payload)
        const wallet = matchWallet(senderEmail, walletIndex)
        if (!wallet) continue

        const source = walletSource(wallet)
        let parsed = parseWithRules(getDomain(senderEmail), body)
        if (!parsed || parsed.amount <= 0) {
          // No rules parser for this bank's format. The browser has no LLM, so
          // this one genuinely does need the scheduled sync.
          if (getParseStrategy(wallet) === 'llm') skippedNeedingLlm++
          continue
        }

        // Direction by arithmetic, exactly as the background sync does it. This
        // is why Opay no longer has to be skipped here: its alerts never say
        // debit or credit, but they always state a balance, and comparing that
        // against the previous one is not a guess.
        if (!hasReliableDirection(parsed)) {
          const fromBalance = directionFromBalance(parsed.available_balance, chain.priorFor(wallet.id))
          if (fromBalance) {
            parsed = { ...parsed, ...fromBalance }
          } else {
            // Cannot settle it here. Store it for review rather than guessing;
            // the scheduled sync will categorize it properly.
            parsed = { ...parsed, confidence: 'LOW' }
          }
        }

        // Advance the chain whether or not this row inserts, so a duplicate
        // from the re-scan overlap still positions the next comparison.
        if (parsed.available_balance != null) chain.observe(wallet.id, parsed.available_balance)

        const check = validateParsedTransaction({ ...parsed, source, wallet_id: wallet.id })
        if (!check.ok) continue

        const txn = check.value
        if (!txn.transaction_id) {
          txn.transaction_id = generateSyntheticId(
            txn.source,
            txn.amount,
            txn.transaction_date,
            txn.description,
          )
        }

        if ((await insertTransaction(txn)) === 'inserted') {
          newTxnsCount++
          if (txn.available_balance != null && txn.wallet_id) {
            const at = `${txn.transaction_date}T${txn.transaction_time}`
            const current = latestBalances.get(txn.wallet_id)
            if (!current || at > current.at) {
              latestBalances.set(txn.wallet_id, { balance: txn.available_balance, at })
            }
          }
        }
      } catch (msgErr) {
        // Nothing to hold back: this path owns no cursor, so a failed message is
        // simply picked up by the next manual sync or the next cron run.
        console.error('Error processing message:', msgErr)
      }
    }

    // Written once, after the loop. Gmail returns newest first, so updating
    // inside the loop left the wallet holding the oldest balance in the batch.
    // Skipped entirely when the stored balance came from a newer alert.
    for (const [walletId, { balance, at }] of latestBalances) {
      const stored = walletIndex.byId?.get(walletId)?.balance_as_of
      if (stored && stored >= at) continue

      const { error: balanceError } = await supabase
        .from('wallets')
        .update({ balance, balance_as_of: at, updated_at: new Date().toISOString() })
        .eq('id', walletId)

      // Discarding this meant that on a database where migration 001 had not
      // run, balance_as_of did not exist, PostgREST rejected every update, and
      // the user still saw "N new transactions synced" while no balance moved.
      if (balanceError) {
        console.error('Balance update failed:', balanceError)
        toast.error('Transactions synced, but balances could not update: ' + balanceError.message)
      }
    }

    // last_sync is deliberately NOT written here -- it belongs to the
    // background sync, the only path that can handle every wallet. But
    // last_checked is a plain heartbeat, and a manual sync is a check, so
    // Settings can stop implying nothing has run.
    await supabase
      .from('integrations')
      .update({ last_checked: new Date().toISOString() })
      .eq('id', integration.id)

    if (truncated) {
      // Not "showing 7 days only" -- truncated means the page cap was hit
      // *inside* that window, so some messages in range were never listed.
      toast.info('Too many emails to read in one go. The scheduled sync will pick up the rest.')
    }

    if (newTxnsCount > 0) {
      toast.success(`${newTxnsCount} new transaction${newTxnsCount === 1 ? '' : 's'} synced`)
    } else {
      toast.info('No new transactions')
    }

    if (skippedNeedingLlm > 0) {
      toast.info(
        `${skippedNeedingLlm} email${skippedNeedingLlm === 1 ? '' : 's'} need the background sync ` +
          '(scheduled 8am, 10am, 2pm, 6pm)',
      )
    }

    return newTxnsCount
  } catch (err) {
    console.error('Gmail sync error:', err)
    toast.error('Sync failed: ' + (err.message || 'Check connection'))
    return 0
  }
}
