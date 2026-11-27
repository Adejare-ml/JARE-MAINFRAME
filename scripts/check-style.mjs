#!/usr/bin/env node
/**
 * The design system's two hard rules, checked mechanically
 * (docs/design-system.md):
 *
 *   1. No emoji. Extended_Pictographic code points, the U+2600-U+27BF
 *      symbol blocks (which hold the stand-ins: check marks, stars, warning
 *      signs) and U+FE0F, the emoji presentation selector. (c), (R) and TM
 *      are exempt.
 *   2. No raw colour: no `-[#...]` arbitrary hex classes and no
 *      (bg|text|border|divide|ring)-(white|black) literals. Use tokens.
 *
 * Usage: node scripts/check-style.mjs [paths...]   (default: src/)
 * Exits 1 and prints file:line for every hit; 0 when clean.
 * Legacy-emoji escapes such as '\u{1F6D2}' (LEGACY_ICON_MAP) are text, not
 * emoji, so they pass.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const EXEMPT = new Set([0x00a9, 0x00ae, 0x2122])
const SOURCE = /\.(jsx?|mjs|cjs|tsx?|css|html|json|md|webmanifest)$/

export function emojiHits(line) {
  const hits = []
  for (const ch of line) {
    const cp = ch.codePointAt(0)
    if (EXEMPT.has(cp)) continue
    if (/\p{Extended_Pictographic}/u.test(ch) || (cp >= 0x2600 && cp <= 0x27bf) || cp === 0xfe0f) {
      hits.push(`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`)
    }
  }
  return hits
}

const RAW_COLOUR = [/-\[#[0-9a-fA-F]{3,8}\]/g, /(?<![\w-])(?:[a-z-]+:)*(?:bg|text|border|divide|ring)-(?:white|black)(?![\w-])/g]

export function colourHits(line) {
  const hits = []
  for (const re of RAW_COLOUR) for (const m of line.matchAll(re)) hits.push(m[0])
  return hits
}

function walk(path, out) {
  const st = statSync(path)
  if (st.isDirectory()) {
    for (const f of readdirSync(path)) {
      if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue
      walk(join(path, f), out)
    }
  } else if (SOURCE.test(path)) out.push(path)
  return out
}

export function checkFiles(paths) {
  const problems = []
  for (const p of paths) {
    if (!existsSync(p)) {
      problems.push({ file: p, line: 0, kind: 'missing', detail: 'no such file' })
      continue
    }
    for (const file of walk(p, [])) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((text, i) => {
        const e = emojiHits(text)
        if (e.length) problems.push({ file, line: i + 1, kind: 'emoji', detail: e.join(' ') })
        const c = colourHits(text)
        if (c.length) problems.push({ file, line: i + 1, kind: 'raw colour', detail: c.join(' ') })
      })
    }
  }
  return problems
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const args = process.argv.slice(2)
  const problems = checkFiles(args.length ? args : ['src'])
  for (const p of problems) console.log(`${relative(process.cwd(), p.file)}:${p.line}  ${p.kind}  ${p.detail}`)
  if (problems.length) {
    console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}`)
    process.exit(1)
  }
  console.log('check-style: clean')
}
