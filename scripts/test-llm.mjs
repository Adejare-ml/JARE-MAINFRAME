/**
 * Smoke-test the LLM providers against a real email.
 *
 * The model IDs and endpoints have never been exercised, and a wrong one only
 * shows up as a silent parse failure buried in a cron log. This confirms both
 * providers in a few seconds.
 *
 *   OLLAMA_API_KEY=... NVIDIA_API_KEY=... node scripts/test-llm.mjs
 *   node scripts/test-llm.mjs tests/fixtures/emails/opay-out.txt
 */

import { readFileSync } from 'node:fs'
import { LLM_CONFIG, hasAnyProvider, extractTransaction } from './llm.mjs'
import { validateParsedTransaction } from '../src/lib/sync/normalize.js'

const fixturePath = process.argv[2] || 'tests/fixtures/emails/opay-out.txt'

console.log('Configuration')
console.log(`  Ollama: ${LLM_CONFIG.ollama.configured ? '🔑' : '— no key'}  ${LLM_CONFIG.ollama.baseUrl}  ${LLM_CONFIG.ollama.model}`)
console.log(`  NVIDIA: ${LLM_CONFIG.nvidia.configured ? '🔑' : '— no key'}  ${LLM_CONFIG.nvidia.baseUrl}  ${LLM_CONFIG.nvidia.model}`)

if (!hasAnyProvider()) {
  console.error('\n❌ Neither OLLAMA_API_KEY nor NVIDIA_API_KEY is set.')
  process.exit(1)
}

let body
try {
  body = readFileSync(fixturePath, 'utf-8')
} catch (err) {
  console.error(`\n❌ Could not read ${fixturePath}: ${err.message}`)
  process.exit(1)
}

console.log(`\nEmail: ${fixturePath} (${body.length} chars)`)
console.log('─'.repeat(60))

const started = Date.now()
const result = await extractTransaction(body, (msg) => console.log(msg))
const elapsed = ((Date.now() - started) / 1000).toFixed(1)

if (!result) {
  console.error(`\n❌ No provider returned a usable transaction (${elapsed}s).`)
  console.error('   A 404 above usually means the model ID is wrong for that account.')
  console.error('   Override with OLLAMA_MODEL / NVIDIA_MODEL rather than editing scripts/llm.mjs.')
  process.exit(1)
}

console.log(`\n✅ ${result.provider} responded in ${elapsed}s`)
console.log(JSON.stringify(result.data, null, 2))

const check = validateParsedTransaction({ ...result.data, source: 'test' })
console.log('\n─'.repeat(60))
if (!check.ok) {
  console.error(`❌ Rejected by validation: ${check.reason}`)
  process.exit(1)
}

console.log('✅ Passes validation')
for (const warning of check.warnings) console.log(`   ⚠️  ${warning}`)
console.log(`\n   direction: ${check.value.type}`)
console.log(`   amount:    ${check.value.amount}`)
console.log(`   date:      ${check.value.transaction_date} ${check.value.transaction_time}`)
console.log(`   category:  ${check.value.category}`)
console.log('\nCheck the direction by eye. It is the field rules cannot get right,')
console.log('and the only reason the LLM path exists.')
