#!/usr/bin/env node
/* global document, window, getComputedStyle -- inside page.evaluate, which runs in the browser */
/**
 * Screenshots for the design review: each route at 360 x 740 in dark and
 * light (and OLED on request), against the DEV fixture session
 * (src/dev/fixture.js), so no backend or sign-in is needed.
 *
 *   npm run shots -- <route> [<route>...] [--themes dark,light,oled]
 *                    [--scenario ok|attention|failing|stale|never|offline|nomigration]
 *                    [--out <dir>] [--width 360] [--height 740] [--prefix name]
 *
 * Writes <out>/<prefix><route>-<theme>.png (the first 740px, what a phone
 * shows) and <route>-<theme>-full.png (the whole page). Starts a Vite dev
 * server on a free port unless SHOTS_URL points at one already running.
 * Also reports horizontal overflow and any text under 12px it finds.
 *
 * Playwright is not a project dependency: it is resolved from the machine's
 * global install (NODE_PATH), the way CI images and this repo's agents have it.
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'

const require = createRequire(import.meta.url)
let playwright
try {
  playwright = require('playwright')
} catch {
  console.error('playwright is not installed globally (npm i -g playwright). It is deliberately not a dependency.')
  process.exit(1)
}

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const routes = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')))
if (routes.length === 0) routes.push('/')
const themes = opt('themes', 'dark,light').split(',')
const scenario = opt('scenario', 'ok')
const out = resolve(opt('out', process.env.SHOTS_DIR || 'shots'))
const width = Number(opt('width', 360))
const height = Number(opt('height', 740))
const prefix = opt('prefix', '')
mkdirSync(out, { recursive: true })

function freePort() {
  return new Promise((res) => {
    const srv = net.createServer()
    srv.listen(0, () => {
      const { port } = srv.address()
      srv.close(() => res(port))
    })
  })
}

async function startServer() {
  if (process.env.SHOTS_URL) return { url: process.env.SHOTS_URL, stop: () => {} }
  const port = await freePort()
  const child = spawn('npx', ['vite', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('vite did not start in 30s')), 30000)
    child.stdout.on('data', (d) => {
      if (String(d).includes('Local')) {
        clearTimeout(timer)
        res()
      }
    })
    child.on('exit', (code) => rej(new Error(`vite exited ${code}`)))
  })
  return { url: `http://localhost:${port}`, stop: () => child.kill() }
}

const slug = (route) => (route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^\w-]+/g, '-'))

const server = await startServer()
const browser = await playwright.chromium.launch()
let problems = 0
try {
  for (const route of routes) {
    for (const theme of themes) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 })
      await context.addInitScript(([t]) => {
        localStorage.setItem('theme_mode', t === 'light' ? 'light' : 'dark')
        localStorage.setItem('oled_background', t === 'oled' ? 'true' : 'false')
        localStorage.setItem('zen_mode', 'false')
      }, [theme])
      const page = await context.newPage()
      page.on('pageerror', (e) => console.warn(`  [pageerror] ${e.message}`))
      const sep = route.includes('?') ? '&' : '?'
      await page.goto(`${server.url}${route}${sep}fixture=${scenario}`, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(500)
      const name = `${prefix}${slug(route)}-${theme}`
      await page.screenshot({ path: join(out, `${name}.png`) })
      await page.screenshot({ path: join(out, `${name}-full.png`), fullPage: true })

      const report = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth > window.innerWidth
        const small = []
        for (const el of document.querySelectorAll('body *')) {
          if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('.sr-only')) continue
          if (parseFloat(cs.fontSize) < 12) small.push(`${el.tagName.toLowerCase()} ${cs.fontSize} "${el.textContent.trim().slice(0, 30)}"`)
        }
        return { overflow, scrollWidth: document.documentElement.scrollWidth, small: small.slice(0, 10) }
      })
      const flags = []
      if (report.overflow) flags.push(`horizontal overflow (${report.scrollWidth}px)`)
      if (report.small.length) flags.push(`text under 12px: ${report.small.join('; ')}`)
      problems += flags.length
      console.log(`${join(out, name)}.png${flags.length ? `  !! ${flags.join(' | ')}` : ''}`)
      await context.close()
    }
  }
} finally {
  await browser.close()
  server.stop()
}
process.exit(problems ? 2 : 0)
