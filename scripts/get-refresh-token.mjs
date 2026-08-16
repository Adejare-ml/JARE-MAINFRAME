/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE-TIME REFRESH TOKEN GENERATOR
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Usage Instructions:
 * 1. Ensure your Google OAuth 2.0 Client in Google Cloud Console has
 *    "http://localhost" added under "Authorized redirect URIs".
 * 
 * 2. Run this script locally on your laptop:
 *    GOOGLE_CLIENT_ID="your_client_id" GOOGLE_CLIENT_SECRET="your_client_secret" node scripts/get-refresh-token.mjs
 * 
 * 3. Open the printed Google Consent URL in your browser.
 * 4. Sign in and approve consent. It asks for gmail.readonly (the transaction
 *    sync) and calendar.readonly (the overnight day brief) together, so one
 *    re-consent covers both and you never have to do this twice.
 * 5. Copy the 'code' query parameter from the redirect URL (or browser page).
 * 6. Paste the code back into the CLI prompt.
 * 7. Copy the printed GOOGLE_REFRESH_TOKEN into your GitHub Repository Secrets!
 * ═══════════════════════════════════════════════════════════════════════════
 */

import readline from 'readline'
import { SCOPES } from './google.mjs'

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('❌ Error: Both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables must be provided.')
  console.error('Example: GOOGLE_CLIENT_ID="xxx" GOOGLE_CLIENT_SECRET="yyy" node scripts/get-refresh-token.mjs')
  process.exit(1)
}

const redirectUri = 'http://localhost'
// Both scopes, from one list shared with the scripts that use them. Asking for
// only what today's script needs is how you end up re-consenting every time a
// feature lands -- and a token issued for Gmail alone fails the calendar call
// with a 403 that says nothing about which scope is missing.
const scope = SCOPES.join(' ')

// Construct authorization URL with offline access and prompt=consent
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
  client_id: GOOGLE_CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: scope,
  access_type: 'offline',
  prompt: 'consent',
}).toString()

console.log('\n🔗 Step 1: Open the following URL in your browser:\n')
console.log(authUrl)
console.log('\n------------------------------------------------------------------')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

rl.question('\n🔑 Step 2: Paste the authorization code here: ', async (code) => {
  rl.close()
  const cleanCode = code.trim()

  if (!cleanCode) {
    console.error('❌ Authorization code cannot be empty.')
    process.exit(1)
  }

  console.log('\n🔄 Exchanging code for refresh token...')

  try {
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code: cleanCode,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    })

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`Token exchange failed (${res.status}): ${errText}`)
    }

    const data = await res.json()

    if (!data.refresh_token) {
      console.error('❌ No refresh_token was returned. Make sure you set prompt=consent and access_type=offline.')
      // The keys only, never the object. That response carries `access_token`
      // and `id_token`, and this is a script somebody may one day run in CI to
      // debug exactly this branch -- at which point printing it puts two live
      // credentials into a log that outlives them.
      console.error(`   Google returned these fields: ${Object.keys(data).join(', ')}`)
      if (data.error) console.error(`   error: ${data.error}`)
      process.exit(1)
    }

    console.log('\n==================================================================')
    console.log('✅ SUCCESS! Here is your GOOGLE_REFRESH_TOKEN:\n')
    console.log(data.refresh_token)
    console.log('\n==================================================================')
    console.log('Copy this refresh token and add it as a secret named GOOGLE_REFRESH_TOKEN in your GitHub repository settings.')
  } catch (err) {
    console.error('❌ Failed to retrieve refresh token:', err.message)
    process.exit(1)
  }
})
