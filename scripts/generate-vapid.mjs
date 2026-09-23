/**
 * Mint the VAPID key pair the morning reminder signs its pushes with.
 *
 * Run once, locally:
 *
 *   node scripts/generate-vapid.mjs
 *
 * Then put the three lines it prints where they belong: the public key in
 * the Cloudflare Pages build variable VITE_VAPID_PUBLIC_KEY (public by
 * design -- it only lets a browser check a push came from this app) and
 * in the Actions secret VAPID_PUBLIC_KEY; the private key in the Actions
 * secret VAPID_PRIVATE_KEY and nowhere else. Rotating the pair invalidates
 * every device's subscription, so each phone has to turn reminders off
 * and on again afterwards.
 *
 * web-push's own generator, since the package is here for sending anyway.
 */

import webpush from 'web-push'

const { publicKey, privateKey } = webpush.generateVAPIDKeys()

console.log('VAPID key pair generated. Keep the private key out of git and out of any VITE_ variable.\n')
console.log('Cloudflare Pages (build variable) and GitHub Actions secret:')
console.log(`  VITE_VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`  VAPID_PUBLIC_KEY=${publicKey}`)
console.log('\nGitHub Actions secret only:')
console.log(`  VAPID_PRIVATE_KEY=${privateKey}`)
console.log('\nOptional Actions variable, a contact the push services can reach if they must:')
console.log('  VAPID_SUBJECT=mailto:you@example.com')
