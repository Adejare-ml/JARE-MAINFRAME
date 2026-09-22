/**
 * Getting your data out.
 *
 * Until this existed, the only copy of every transaction, goal and debt was
 * the one in the database, and the only way to see it outside the app was
 * the Supabase dashboard. Pure on purpose: rows in, text out. The browser
 * parts -- the Blob, the download click -- live in ExportData.jsx.
 */

import { isMissingTableError } from './schema.js'

/**
 * Every table you own, in the order they are worth reading. `integrations`
 * is left out on purpose: it holds a Google token, and a backup file that
 * leaks a credential is worse than an incomplete one. `raw_email` is dropped
 * from the CSV for the reason queries.js never selects it -- kilobytes of
 * bank email per row -- but kept in the JSON bundle, which exists to be a
 * complete copy.
 */
export const EXPORT_TABLES = [
  { name: 'transactions', order: 'transaction_date', csvOmit: ['raw_email'] },
  { name: 'wallets', order: 'created_at' },
  { name: 'goals', order: 'target_date' },
  { name: 'debts', order: 'created_at' },
  { name: 'projects', order: 'month' },
  { name: 'milestones', order: 'created_at' },
  { name: 'repairs', order: 'created_at' },
  { name: 'category_rules', order: 'priority' },
  { name: 'category_budgets', order: 'category' },
  { name: 'category_corrections', order: 'created_at' },
  { name: 'wallet_snapshots', order: 'snapshot_date' },
  { name: 'week_recaps', order: 'week_start' },
  { name: 'day_briefs', order: 'brief_date' },
  { name: 'knowledge_gaps', order: 'created_at' },
  { name: 'user_settings', order: 'key' },
  { name: 'sync_failures', order: 'last_failed_at' },
  { name: 'sync_runs', order: 'finished_at' },
]

/** PostgREST answers at most this many rows per request, whatever you ask. */
export const PAGE_SIZE = 1000

/** So Excel opens the file as UTF-8 and shows ₦ rather than Ã¢â€šÂ¦. */
export const BOM = '﻿'

/**
 * The column set across every row, in first-seen order, minus `omit` --
 * rows from one table can differ in keys when a column is null on some and
 * absent on none, but jsonb rows and healed tables have taught this app not
 * to trust the first row alone.
 */
export function columnsFor(rows = [], omit = []) {
  const skip = new Set(omit)
  const seen = new Set()
  const columns = []
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue
    for (const key of Object.keys(row)) {
      if (skip.has(key) || seen.has(key)) continue
      seen.add(key)
      columns.push(key)
    }
  }
  return columns
}

/**
 * One CSV cell. Strings starting with = + - @ get a leading apostrophe so a
 * spreadsheet shows them rather than running them as a formula (a
 * recipient named "=HYPERLINK(...)" is the classic); numbers are numbers,
 * so a negative amount is not touched.
 */
export function csvCell(value) {
  if (value == null) return ''
  let text
  if (typeof value === 'string') {
    text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  } else if (typeof value === 'object') {
    text = JSON.stringify(value)
  } else {
    text = String(value)
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * RFC 4180: comma-separated, CRLF line endings, quotes doubled inside
 * quoted fields, a header row first. BOM-prefixed (see BOM).
 *
 * @param {object[]} rows
 * @param {string[]} [columns] - defaults to columnsFor(rows)
 * @returns {string}
 */
export function toCsv(rows = [], columns = columnsFor(rows)) {
  const lines = [columns.map(csvCell).join(',')]
  for (const row of rows || []) {
    if (!row) continue
    lines.push(columns.map((c) => csvCell(row[c])).join(','))
  }
  return BOM + lines.join('\r\n') + '\r\n'
}

/**
 * Read a whole table a page at a time. PostgREST caps a response at 1000
 * rows silently -- an export that asked once would look complete and be
 * missing everything past the first thousand.
 *
 * @param {(from: number, to: number) => Promise<{data: object[]|null, error: object|null}>} page - runs `.range(from, to)`
 * @returns {Promise<object[]>}
 */
export async function fetchAll(page) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const chunk = data || []
    rows.push(...chunk)
    if (chunk.length < PAGE_SIZE) return rows
  }
}

/**
 * Every table into one object. A table the database does not have yet (a
 * migration not run) is recorded under `skipped`, not fatal -- a backup that
 * refuses to run because one optional table is absent is no backup.
 *
 * @param {Array<{name: string}>} tables
 * @param {(table: {name: string}) => Promise<object[]>} fetchTable
 * @param {{exportedAt?: Date}} [options]
 */
export async function buildBundle(tables, fetchTable, { exportedAt = new Date() } = {}) {
  const bundle = { exported_at: exportedAt.toISOString(), app: 'jare-mainframe', tables: {}, skipped: [] }
  for (const table of tables) {
    try {
      bundle.tables[table.name] = await fetchTable(table)
    } catch (err) {
      bundle.skipped.push({
        table: table.name,
        reason: isMissingTableError(err) ? 'table does not exist yet (migration not run)' : err?.message || String(err),
      })
    }
  }
  return bundle
}

/** `jare-transactions-2026-09-22.csv`, `jare-mainframe-2026-09-22.json`. */
export function filenameFor(table, ext, date = new Date()) {
  const day = date.toISOString().slice(0, 10)
  return table ? `jare-${table}-${day}.${ext}` : `jare-mainframe-${day}.${ext}`
}
