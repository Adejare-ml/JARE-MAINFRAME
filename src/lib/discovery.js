/**
 * Accounts the mailbox knows about before the app does.
 *
 * The daily audit reads bank alerts from the senders the owner has told it
 * about (migration 041 seeds a wallet per sender). Everything else in the
 * mailbox that looks like a bank is skipped: a new fintech the owner signed
 * up to, a loan app, a cooperative that mails statements, a second bank
 * account. Those are exactly the balances a personal finance system should
 * not be blind to, so migration 043 gives the audit somewhere to put them:
 * `discovered_accounts`, one row per sender or slug it has seen and the app
 * has no wallet for, with the last balance and date it saw.
 *
 * The owner decides, not the pipeline: a discovered account waits as "new"
 * until the owner says Track (a wallet is made and future alerts land in
 * the ledger) or Ignore (the row stays, muted, so the question is not asked
 * again). The question is asked in two places that already exist, the
 * morning push digest and the Needs Attention card on Daily HQ, and repeated
 * weekly while unanswered, never daily.
 *
 * Pure: rows and a date in, words and decisions out. The component and the
 * script fetch; this decides. Loads under plain Node like every src/lib
 * module.
 */

export const DISCOVERY_STATUS = { NEW: 'new', TRACKING: 'tracking', IGNORED: 'ignored' }

/** Days between reminders about an account still waiting for a decision. */
export const NAG_EVERY_DAYS = 7

/** Where a tap on a discovered-account item lands. */
export const DISCOVERY_URL = '/settings#discovered'

const money = (n) => `₦${Math.round(Number(n) || 0).toLocaleString('en-US')}`

function dayDiff(fromDate, toDate) {
  const a = new Date(`${String(fromDate).slice(0, 10)}T00:00:00`)
  const b = new Date(`${String(toDate).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.round((b - a) / 86400000)
}

/**
 * A wallet slug from a sender address or a bank name: lowercase letters
 * and digits, the domain's own word when it is an address.
 *
 * "no-reply@kuda.com" → "kuda"; "alerts@mail.moniepoint.com" → "moniepoint";
 * "Fairmoney Microfinance Bank" → "fairmoney".
 *
 * @param {string} senderOrName
 * @returns {string}
 */
export function slugFromSender(senderOrName) {
  const raw = String(senderOrName || '').trim().toLowerCase()
  if (!raw) return ''
  const at = raw.indexOf('@')
  if (at >= 0) {
    const domain = raw.slice(at + 1).replace(/>.*$/, '')
    const parts = domain.split('.').filter(Boolean)
    // Drop generic prefixes and the TLD: mail.kuda.com → kuda, kuda.com.ng → kuda.
    const generic = new Set(['mail', 'email', 'alerts', 'alert', 'notify', 'notifications', 'noreply', 'no-reply', 'info', 'www', 'com', 'ng', 'co', 'net', 'org', 'io', 'africa'])
    const candidates = parts.filter((p) => !generic.has(p))
    const pick = candidates.length ? candidates[candidates.length - 1] : parts[0] || ''
    return pick.replace(/[^a-z0-9]/g, '').slice(0, 24)
  }
  const words = raw.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)
  const stop = new Set(['bank', 'plc', 'limited', 'ltd', 'microfinance', 'mfb', 'nigeria', 'the', 'of', 'and'])
  const first = words.find((w) => !stop.has(w)) || words[0] || ''
  return first.slice(0, 24)
}

/**
 * A label a human reads: the sender's display name when it has one, else
 * the domain word capitalised.
 *
 * @param {string} sender - "Kuda <no-reply@kuda.com>" or "no-reply@kuda.com"
 * @param {string} [fallback]
 */
export function labelFromSender(sender, fallback = '') {
  const raw = String(sender || '').trim()
  const named = raw.match(/^"?([^"<]+?)"?\s*<[^>]+>$/)
  if (named && named[1].trim()) return named[1].trim().slice(0, 60)
  const slug = slugFromSender(raw)
  if (slug) return slug.charAt(0).toUpperCase() + slug.slice(1)
  return String(fallback || '').slice(0, 60)
}

/**
 * The wallet type to suggest when the owner tracks an account. Savings and
 * loan apps are savings; everything with "pay" or a known mobile-money
 * name is mobile; the rest is a bank.
 *
 * @param {string} slug
 * @returns {'bank'|'mobile'|'savings'|'investment'|'cash'}
 */
export function suggestWalletType(slug) {
  const s = String(slug || '').toLowerCase()
  if (/piggy|cowry|save|ajo|esusu|sumo/.test(s)) return 'savings'
  if (/risevest|bamboo|trove|chaka|invest|stock/.test(s)) return 'investment'
  if (/pay|opay|palm|moniepoint|kuda|carbon|fairmoney|branch|momo|wallet|paga|chipper|flutter|paystack/.test(s)) return 'mobile'
  return 'bank'
}

/** True while the owner has asked not to be asked (048's snooze_until). */
export function isSnoozed(account, today) {
  const until = account?.snooze_until ? String(account.snooze_until).slice(0, 10) : null
  if (!until || !today) return false
  return until > today
}

/**
 * Rows still waiting for the owner's decision, oldest first. With a date,
 * rows snoozed past it are left out (the card and the digest); without
 * one, every undecided row (Settings, which lists them all).
 *
 * @param {object[]} accounts
 * @param {string} [today] - YYYY-MM-DD
 */
export function awaitingDecision(accounts, today) {
  return (accounts || [])
    .filter((a) => a && (a.status || DISCOVERY_STATUS.NEW) === DISCOVERY_STATUS.NEW)
    .filter((a) => !today || !isSnoozed(a, today))
    .sort((a, b) => String(a.first_seen_at || '').localeCompare(String(b.first_seen_at || '')))
}

/**
 * Whether an undecided account should be mentioned today.
 *
 * Since 048 the reminder stamps `asked_at` when it asks, so the rule is:
 * not while snoozed; the first time ever (no stamp); then once every
 * NAG_EVERY_DAYS since the last stamp. A row from before 048 carries no
 * stamp and falls back to the old rule, the day it was first seen and
 * every NAG_EVERY_DAYS from there, so a question ignored for a month has
 * been asked four times, not thirty.
 *
 * @param {{first_seen_at?: string, asked_at?: string|null, snooze_until?: string|null}} account
 * @param {string} today - YYYY-MM-DD
 */
export function dueToAsk(account, today) {
  if (isSnoozed(account, today)) return false
  if (account && 'asked_at' in account) {
    const asked = account.asked_at ? String(account.asked_at).slice(0, 10) : null
    if (!asked) return true
    const since = dayDiff(asked, today)
    return since == null || since >= NAG_EVERY_DAYS
  }
  const first = account?.first_seen_at ? String(account.first_seen_at).slice(0, 10) : null
  if (!first) return true
  const days = dayDiff(first, today)
  if (days == null || days < 0) return true
  return days % NAG_EVERY_DAYS === 0
}

/** The date a snooze set today runs to: next week, as YYYY-MM-DD. */
export function snoozeUntil(today, days = NAG_EVERY_DAYS) {
  const d = new Date(`${String(today).slice(0, 10)}T00:00:00`)
  d.setDate(d.getDate() + days)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The undecided rows worth asking about today; the reminder stamps these. */
export function accountsToAsk(accounts, today) {
  return awaitingDecision(accounts, today).filter((a) => dueToAsk(a, today))
}

/**
 * One line per account worth asking about today, in the digest's item
 * shape ({kind, text, url, days}).
 *
 * @param {object[]} accounts - discovered_accounts rows
 * @param {string} today
 */
export function discoveryItems(accounts, today) {
  return accountsToAsk(accounts, today)
    .map((a) => {
      const seen = a.last_seen_on ? dayDiff(a.last_seen_on, today) : null
      const ago = seen == null ? '' : seen <= 0 ? ' today' : seen === 1 ? ' yesterday' : ` ${seen}d ago`
      const balance = a.last_balance != null ? `, ${money(a.last_balance)}${ago}` : ''
      return {
        kind: 'account',
        text: `New account in your mail: ${a.label || a.slug}${balance}. Track it?`,
        url: DISCOVERY_URL,
        days: null,
      }
    })
}

/** "Kuda · last seen 3 days ago · ₦12,400 · seen 4 times" for a list row. */
export function describeDiscovered(a, today) {
  if (!a) return ''
  const parts = [a.label || a.slug]
  if (a.last_seen_on) {
    const d = dayDiff(a.last_seen_on, today)
    parts.push(d == null ? `last seen ${a.last_seen_on}` : d <= 0 ? 'seen today' : d === 1 ? 'seen yesterday' : `last seen ${d} days ago`)
  }
  if (a.last_balance != null) parts.push(money(a.last_balance))
  if (a.times_seen > 1) parts.push(`${a.times_seen} alerts`)
  if (today && isSnoozed(a, today)) parts.push(`asks again ${String(a.snooze_until).slice(0, 10)}`)
  return parts.join(' · ')
}

/**
 * The wallet row to create when the owner says Track.
 *
 * @param {object} account - a discovered_accounts row
 * @param {{name?: string, type?: string}} [choice]
 */
export function walletFromDiscovered(account, choice = {}) {
  const slug = String(account?.slug || slugFromSender(account?.sender)).slice(0, 24)
  return {
    name: String(choice.name || account?.label || slug).trim().slice(0, 60),
    type: ['bank', 'mobile', 'savings', 'investment', 'cash'].includes(choice.type) ? choice.type : suggestWalletType(slug),
    source_slug: slug,
    alert_sender: account?.sender ? String(account.sender).replace(/^.*<([^>]+)>.*$/, '$1').trim().slice(0, 120) : null,
    balance: account?.last_balance != null ? Number(account.last_balance) : 0,
    parse_strategy: 'llm',
  }
}
