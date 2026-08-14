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
