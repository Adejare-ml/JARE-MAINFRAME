/**
 * Google credentials, shared by every script that needs them.
 *
 * Extracted from gmail-sync.mjs when the day planner became the second caller.
 * The refresh dance is identical either way, and the interesting part of it is
 * the `invalid_grant` message -- which took several silent scheduled failures to
 * work out and would not have been rewritten from scratch in a second copy.
 *
 * The one thing this adds beyond a straight extraction is `grantedScopes`.
 * Google's token response says what the refresh token is actually allowed to
 * do, and knowing that up front turns "403 from the calendar API" into "this
 * token was issued for Gmail only, re-run scripts/get-refresh-token.mjs" --
 * which is the difference between a diagnosable failure and a puzzling one.
 */

/**
 * Scopes this project asks for.
 *
 * `gmail.readonly` for the transaction sync, `calendar.readonly` for the day
 * brief. Both readonly: nothing here has any business writing to an inbox or a
 * calendar, and a token that cannot do damage is one fewer thing to worry about
 * if it leaks.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
]

export const GMAIL_SCOPE = SCOPES[0]
export const CALENDAR_SCOPE = SCOPES[1]

/**
 * Exchange the refresh token for an access token.
 *
 * @param {{clientId: string, clientSecret: string, refreshToken: string}} credentials
 * @returns {Promise<{accessToken: string, grantedScopes: Array<string>}>}
 */
export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })

  if (!res.ok) {
    const body = await res.text()

    // invalid_grant means the refresh token is dead, not that anything is wrong
    // with this run. Say what to do about it: the raw Google payload tells you
    // the token expired and nothing else, which is how this sat broken through
    // several scheduled runs.
    if (body.includes('invalid_grant')) {
      throw new Error(
        'Google refresh token is expired or revoked.\n' +
          '  Fix: run this locally, then paste the result into the ' +
          'GOOGLE_REFRESH_TOKEN repository secret:\n' +
          '    GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." node scripts/get-refresh-token.mjs\n' +
          '  If this keeps happening every ~7 days, the OAuth consent screen for this ' +
          'Google Cloud project is still in "Testing" publishing status -- Google ' +
          'expires those refresh tokens weekly. Setting it to "In production" stops it.\n' +
          `  Google said: ${body}`,
      )
    }

    throw new Error(`Google token refresh failed (${res.status}): ${body}`)
  }

  const data = await res.json()

  return {
    accessToken: data.access_token,
    // Space-separated in the response. Absent on some responses, in which case
    // an empty list is the honest answer -- `hasScope` then reports false and
    // the caller says "cannot read the calendar" rather than assuming it can.
    grantedScopes: String(data.scope || '').split(' ').filter(Boolean),
  }
}

/**
 * Was this token issued with a scope, and if not, what does the person do?
 *
 * @param {Array<string>} grantedScopes
 * @param {string} scope
 */
export function hasScope(grantedScopes, scope) {
  return (grantedScopes || []).includes(scope)
}

/** The sentence to print when a scope is missing. One place, so it stays right. */
export function reconsentMessage(scope) {
  return (
    `The Google refresh token was not issued with ${scope}.\n` +
    '  Fix: re-run the helper and paste the new value into the ' +
    'GOOGLE_REFRESH_TOKEN repository secret:\n' +
    '    GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." node scripts/get-refresh-token.mjs\n' +
    '  It now asks for Gmail and Calendar together, so one re-consent covers both.'
  )
}
