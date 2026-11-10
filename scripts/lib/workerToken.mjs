/**
 * The diet-photo worker token for the GitHub jobs, derived from the service
 * key rather than kept as a secret of its own: one less secret to copy into
 * two places. The deploy workflow (.github/workflows/deploy-diet-functions.yml)
 * runs `node scripts/lib/workerToken.mjs` to set the same value as the edge
 * function's DIET_WORKER_TOKEN; the Ollama job sends it in x-worker-token.
 *
 * A one-way HMAC: the token cannot give back the service key, and a new
 * service key (or a new label) gives a new token. The laptop worker can be
 * given the same value from that command.
 *
 * Added after Phase 4.
 */
import { createHmac } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const WORKER_TOKEN_LABEL = 'jare-diet-worker-v1'

export function workerToken(serviceKey) {
  if (!serviceKey) throw new Error('the service key is required to derive the worker token')
  return createHmac('sha256', serviceKey).update(WORKER_TOKEN_LABEL).digest('hex')
}

// `node scripts/lib/workerToken.mjs` prints it, for the deploy step only.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.stdout.write(workerToken(process.env.SUPABASE_SERVICE_KEY))
}
