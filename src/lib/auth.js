/**
 * Sign-in helpers with no DOM and no network, so they can be tested.
 *
 * The reset flow itself is Supabase's: a link is emailed, the link lands
 * on /reset-password with a one-time code, the client exchanges it for a
 * session and fires PASSWORD_RECOVERY, and the new password is saved with
 * updateUser. What this module owns is the two decisions around that:
 * whether the current URL is that landing (so the reset page shows before
 * the auth event arrives, instead of the sign-in page flashing first), and
 * whether a proposed password is acceptable before a request is made.
 */

/** Supabase's own floor is 6; the app asks for a little more. */
export const PASSWORD_MIN = 8

/** The path the reset email sends the browser back to. */
export const RECOVERY_PATH = '/reset-password'

/**
 * True when this location is the reset link's landing.
 *
 * Two shapes exist: the PKCE flow arrives on RECOVERY_PATH with `?code=`,
 * and the older implicit flow arrives anywhere with `#…type=recovery`.
 * Either one means "show the reset page".
 *
 * @param {{pathname?: string, search?: string, hash?: string}|string|null} location
 */
export function isRecoveryUrl(location) {
  if (!location) return false
  let pathname = ''
  let search = ''
  let hash = ''
  if (typeof location === 'string') {
    try {
      const url = new URL(location, 'https://placeholder.invalid')
      pathname = url.pathname
      search = url.search
      hash = url.hash
    } catch {
      return false
    }
  } else {
    pathname = location.pathname || ''
    search = location.search || ''
    hash = location.hash || ''
  }
  if (pathname === RECOVERY_PATH && /[?&]code=/.test(search)) return true
  return /(^#|[&#])type=recovery(&|$)/.test(hash)
}

/**
 * Whether a new password can be saved.
 *
 * @param {string} password
 * @param {string} confirm
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateNewPassword(password, confirm) {
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, error: 'Enter a new password' }
  }
  if (password.length < PASSWORD_MIN) {
    return { ok: false, error: `Use at least ${PASSWORD_MIN} characters` }
  }
  if (password !== confirm) {
    return { ok: false, error: 'The two passwords do not match' }
  }
  return { ok: true }
}

/**
 * The one message the "forgot password" form ever shows on success, so a
 * reply can never say whether an address has an account. A rate-limit
 * refusal is the exception, since it says nothing about the address.
 */
export const RESET_SENT_MESSAGE =
  'If that address has an account, a reset link is on its way. Check your inbox and spam folder.'

/** True for Supabase's "too soon" refusal, which is safe to show as is. */
export function isRateLimitError(error) {
  if (!error) return false
  if (error.status === 429) return true
  return /rate limit|only request this after|too many requests/i.test(error.message || '')
}
