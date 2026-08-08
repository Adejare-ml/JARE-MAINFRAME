/**
 * Smoke-test the LLM providers against a real email.
 *
 * The model IDs and endpoints are the single point where this feature silently
 * becomes a no-op: a wrong name, a missing secret or a model that reasons past
 * its token budget all surface the same way in production -- as everything
 * quietly landing in the review queue as Uncategorized.
 *
 * Tests BOTH providers independently rather than stopping at the first that
 * answers. The fallback existing but not working is precisely the failure worth
 * knowing about before a bad night for Ollama reveals it.
 *
 *   OLLAMA_API_KEY=... NVIDIA_API_KEY=... node scripts/test-llm.mjs
 *   node scripts/test-llm.mjs tests/fixtures/emails/opay-out.txt
 */

import { readFileSync } from 'node:fs'
import { LLM_CONFIG, hasAnyProvider, probeProvider } from './llm.mjs'
import { validateParsedTransaction } from '../src/lib/sync/normalize.js'

const fixturePath = process.argv[2] || 'tests/fixtures/emails/opay-out.txt'

console.log('Configuration')
console.log(`  Ollama: ${LLM_CONFIG.ollama.configured ? '🔑 key set' : '— NO KEY'}  ${LLM_CONFIG.ollama.baseUrl}  ${LLM_CONFIG.ollama.model}`)
console.log(`  NVIDIA: ${LLM_CONFIG.nvidia.configured ? '🔑 key set' : '— NO KEY'}  ${LLM_CONFIG.nvidia.baseUrl}  ${LLM_CONFIG.nvidia.model}`)

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

const outcomes = []

for (const name of ['ollama', 'nvidia']) {
  console.log(`\n${'─'.repeat(60)}\n${name.toUpperCase()}  ${LLM_CONFIG[name].model}`)

  if (!LLM_CONFIG[name].configured) {
    console.log('  ⏭  skipped, no key set')
    outcomes.push({ name, ok: false, reason: 'no key' })
    continue
  }

  const started = Date.now()
  const result = await probeProvider(name, body)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  if (!result.ok) {
    console.log(`  ❌ ${elapsed}s — ${result.error}`)
    outcomes.push({ name, ok: false, reason: result.error })
    continue
  }

  console.log(`  ✅ responded in ${elapsed}s`)
  console.log(`  ${JSON.stringify(result.data)}`)

  const check = validateParsedTransaction({ ...result.data, source: 'test' })
  if (!check.ok) {
    console.log(`  ⚠️  fails validation: ${check.reason}`)
    outcomes.push({ name, ok: false, reason: `validation: ${check.reason}` })
    continue
  }

  console.log(`     direction ${check.value.type} · amount ${check.value.amount} · ${check.value.category}`)
  for (const w of check.warnings) console.log(`     ⚠️  ${w}`)
  outcomes.push({ name, ok: true })
}

console.log(`\n${'═'.repeat(60)}`)
for (const o of outcomes) {
  console.log(`  ${o.ok ? '✅' : '❌'} ${o.name}${o.ok ? '' : ` — ${o.reason}`}`)
}

const working = outcomes.filter((o) => o.ok)
if (working.length === 0) {
  console.error('\n❌ No provider works. Categorization would silently degrade to Uncategorized.')
  process.exit(1)
}
if (working.length === 1) {
  console.warn(`\n⚠️  Only ${working[0].name} works. There is no fallback if it goes down.`)
  process.exit(0)
}

console.log('\n✅ Both providers work. Check the direction above by eye — it is the')
console.log('   field rules cannot get right, and the reason this path exists.')
