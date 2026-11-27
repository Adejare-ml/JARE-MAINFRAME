/**
 * Format a number as Nigerian Naira
 * @param {number} amount
 * @returns {string} e.g. "₦5,808.09"
 */
export function formatNaira(amount) {
  if (amount == null || isNaN(amount)) return '₦0.00'
  return '₦' + Number(amount).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Format a goal's figure in whatever it is actually counting.
 *
 * Most goals count money and there was no need for this until goals started
 * counting commits too. Rendering "₦3.00" where the goal means three commits is
 * not a cosmetic slip -- it is the app stating a number in a unit that makes it
 * false, on the one screen whose whole job is to be checkable.
 *
 * Falls through to naira for every metric that is not about a repository, so a
 * new money metric needs no change here.
 *
 * @param {number} amount
 * @param {string} [metric] - a goals.metric value
 * @returns {string}
 */
export function formatGoalAmount(amount, metric) {
  if (metric !== 'repo_commits') return formatNaira(amount)

  const count = Math.round(Number(amount) || 0)
  return `${count.toLocaleString('en-NG')} commit${count === 1 ? '' : 's'}`
}

/**
 * Format a date string to readable format
 * @param {string} dateString - e.g. "2026-07-29"
 * @returns {string} e.g. "Wed, 29 Jul 2026"
 */
export function formatDate(dateString) {
  if (!dateString) return ''
  const date = new Date(dateString + 'T00:00:00')
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Format a time string to 12-hour format
 * @param {string} timeString - e.g. "20:02:23"
 * @returns {string} e.g. "8:02 PM"
 */
export function formatTime(timeString) {
  if (!timeString) return ''
  const [hours, minutes] = timeString.split(':')
  const h = parseInt(hours, 10)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 || 12
  return `${hour12}:${minutes} ${ampm}`
}

/**
 * Returns a human-readable time-ago string
 * @param {string|Date} timestamp
 * @returns {string} e.g. "2 mins ago", "yesterday", "3 days ago"
 */
export function timeAgo(timestamp) {
  if (!timestamp) return ''
  const now = new Date()
  const then = new Date(timestamp)
  const diffMs = now - then
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) return 'just now'
  if (diffMins < 60) return `${diffMins} min${diffMins === 1 ? '' : 's'} ago`
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 30) return `${diffDays} days ago`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) === 1 ? '' : 's'} ago`
  return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) === 1 ? '' : 's'} ago`
}

/**
 * What to call the signed-in person. Daily HQ's greeting used to hardcode a
 * name, which is the kind of thing that makes a system feel unfinished the
 * moment anyone else signs in.
 *
 * @param {{email?: string, user_metadata?: {name?: string, full_name?: string}}|null} user
 * @returns {string}
 */
export function displayName(user) {
  const meta = user?.user_metadata || {}
  const named = String(meta.name || meta.full_name || '').trim()
  if (named) return named.split(/\s+/)[0]

  const local = String(user?.email || '').split('@')[0].trim()
  if (!local) return 'there'
  const word = local.split(/[._-]/)[0]
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * Returns a Tailwind background color class for a transaction category
 * @param {string} category
 * @returns {string} Tailwind class
 */
export function getCategoryColor(category) {
  const colors = {
    'Feeding / Groceries': 'bg-orange-500',
    'Transport': 'bg-blue-500',
    'Airtime & Data': 'bg-purple-500',
    'Electricity': 'bg-yellow-500',
    'Generator': 'bg-yellow-600',
    'Rent': 'bg-red-500',
    'Water': 'bg-cyan-500',
    'Work Expenses': 'bg-indigo-500',
    'Courses & Learning': 'bg-teal-500',
    'Tools & Software': 'bg-violet-500',
    'Equipment': 'bg-slate-500',
    'Pharmacy': 'bg-rose-500',
    'Hospital / Clinic': 'bg-red-400',
    'Personal Care': 'bg-pink-400',
    'Family Support': 'bg-pink-500',
    'Social Events': 'bg-amber-500',
    'Church / Mosque': 'bg-emerald-500',
    'Ajo / Esusu': 'bg-lime-500',
    'Loan Repayment': 'bg-red-600',
    'Bank Charges': 'bg-gray-600',
    'Savings Transfer': 'bg-green-600',
    'Savings': 'bg-green-600',
    'Investment': 'bg-purple-600',
    'Transfer Out': 'bg-teal-600',
    'Transfer In': 'bg-teal-600',
    'Clothing & Fashion': 'bg-fuchsia-500',
    'Entertainment': 'bg-sky-500',
    'Dining Out': 'bg-orange-400',
    'Subscriptions': 'bg-indigo-400',
    'Repairs': 'bg-stone-500',
    'Miscellaneous': 'bg-neutral-500',
    'Uncategorized': 'bg-gray-500',
  }
  return colors[category] || 'bg-gray-500'
}

/** U+2212, the real minus sign. Negative figures use it before the ₦, never brackets. */
export const MINUS = '−'

function groupWhole(n) {
  return Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 0 })
}

/**
 * Naira with an explicit sign rule, for the Money primitive.
 *
 * @param {number} amount
 * @param {{kobo?: boolean, sign?: boolean}} [opts] - kobo: two decimals
 *   (default true); sign: a leading + on positive amounts (negatives always
 *   carry U+2212)
 * @returns {string} e.g. "₦5,808.09", "−₦2,500.00", "+₦12,000"
 */
export function formatNairaSigned(amount, { kobo = true, sign = false } = {}) {
  const n = Number(amount)
  if (amount == null || !Number.isFinite(n)) return kobo ? '₦0.00' : '₦0'
  // Half away from zero, so −₦499.50 and ₦499.50 round to the same size.
  const round = (x) => Math.sign(x) * Math.round(Math.abs(x))
  const value = kobo ? round(n * 100) / 100 : round(n)
  const body = kobo
    ? Math.abs(value).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : groupWhole(value)
  const prefix = value < 0 ? MINUS : sign && value > 0 ? '+' : ''
  return `${prefix}₦${body}`
}

/**
 * Whole naira, kobo dropped (rounded), for hero figures.
 * @param {number} amount
 * @returns {string} e.g. "₦1,234,568", "−₦500"
 */
export function formatNairaWhole(amount) {
  return formatNairaSigned(amount, { kobo: false })
}

/**
 * Compact naira for figures too long to sit whole at hero size.
 * @param {number} amount
 * @returns {string} e.g. "₦1.23B", "₦4.5M", "₦12.3K", "₦950"
 */
export function formatNairaCompact(amount) {
  const n = Number(amount)
  if (amount == null || !Number.isFinite(n)) return '₦0'
  const abs = Math.abs(n)
  const prefix = n < 0 ? MINUS : ''
  const units = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units) {
    if (abs >= size) {
      // Two decimals, trailing zeros trimmed: ₦1.20B reads as ₦1.2B.
      const scaled = Math.floor((abs / size) * 100) / 100
      return `${prefix}₦${scaled.toFixed(2).replace(/\.?0+$/, '')}${suffix}`
    }
  }
  return `${prefix}₦${groupWhole(Math.round(abs))}`
}

/**
 * A run time for the status rail: "09:14" today, "Yesterday 21:40", or
 * "2d ago". Never a ticking clock.
 *
 * @param {string|Date|null} timestamp
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRailTime(timestamp, now = new Date()) {
  if (!timestamp) return ''
  const t = new Date(timestamp)
  if (Number.isNaN(t.getTime())) return ''
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86400000)
  if (days <= 0) return hhmm
  if (days === 1) return `Yesterday ${hhmm}`
  return `${days}d ago`
}

/**
 * How long ago, in the rail's short form: "5h", "2d".
 * @param {string|Date|null} timestamp
 * @param {Date} [now]
 */
export function shortAge(timestamp, now = new Date()) {
  if (!timestamp) return ''
  const hours = Math.max(0, (now - new Date(timestamp)) / 3600000)
  if (hours < 48) return `${Math.max(1, Math.floor(hours))}h`
  return `${Math.floor(hours / 24)}d`
}
