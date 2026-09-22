import { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { toast } from '../../lib/toast'
import { EXPORT_TABLES, toCsv, columnsFor, fetchAll, buildBundle, filenameFor } from '../../lib/export'

/**
 * The way out. One table as a spreadsheet, or everything as one JSON file
 * -- the copy of your own numbers that lives somewhere other than a
 * database you do not run. Self-contained like the sections above it.
 *
 * No zip, so CSVs come one at a time: a zip needs a dependency this app has
 * gone without, and the JSON bundle is the "everything" case anyway.
 */

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked on the next tick, not synchronously: Safari has been seen to
  // cancel a download whose URL vanished before the click landed.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const readTable = (table) =>
  fetchAll((from, to) => supabase.from(table.name).select('*').order(table.order, { ascending: true }).range(from, to))

export default function ExportData() {
  const [table, setTable] = useState(EXPORT_TABLES[0].name)
  const [busy, setBusy] = useState(null)

  const exportCsv = async () => {
    const meta = EXPORT_TABLES.find((t) => t.name === table)
    setBusy('csv')
    try {
      const rows = await readTable(meta)
      download(filenameFor(meta.name, 'csv'), toCsv(rows, columnsFor(rows, meta.csvOmit || [])), 'text/csv;charset=utf-8')
      toast.success(`${rows.length} row${rows.length === 1 ? '' : 's'} exported`)
    } catch (err) {
      toast.error('Could not export: ' + (err?.message || 'check connection'))
    } finally {
      setBusy(null)
    }
  }

  const exportJson = async () => {
    setBusy('json')
    try {
      const bundle = await buildBundle(EXPORT_TABLES, readTable)
      download(filenameFor(null, 'json'), JSON.stringify(bundle, null, 2), 'application/json')
      const count = Object.values(bundle.tables).reduce((n, rows) => n + rows.length, 0)
      toast.success(
        `${count} row${count === 1 ? '' : 's'} across ${Object.keys(bundle.tables).length} tables` +
          (bundle.skipped.length ? ` (${bundle.skipped.length} skipped)` : ''),
      )
    } catch (err) {
      toast.error('Could not export: ' + (err?.message || 'check connection'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="bg-card rounded-3xl p-6 border border-white/10 space-y-4">
      <h2 className="text-xs font-semibold text-muted uppercase tracking-wider border-b border-white/5 pb-3">Export</h2>

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1">
          <label htmlFor="export-table" className="block text-xs text-muted font-semibold mb-1">
            One table as a spreadsheet
          </label>
          <select
            id="export-table"
            value={table}
            onChange={(e) => setTable(e.target.value)}
            className="w-full px-4 py-3 bg-background border border-white/10 rounded-xl text-white text-sm focus:outline-none focus:border-accent min-h-[48px]"
          >
            {EXPORT_TABLES.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={exportCsv}
          disabled={busy !== null}
          className="px-5 py-3 bg-white/5 hover:bg-white/10 text-white text-sm font-bold rounded-xl min-h-[48px] disabled:opacity-50"
        >
          {busy === 'csv' ? 'Exporting…' : 'Download CSV'}
        </button>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-white/5">
        <div>
          <p className="text-sm text-white font-semibold">Everything, as one file</p>
          <p className="text-[11px] text-muted-dim mt-0.5">
            Every table you own, including bank email bodies. The Gmail connection itself is never exported.
          </p>
        </div>
        <button
          onClick={exportJson}
          disabled={busy !== null}
          className="px-5 py-3 bg-accent text-black text-sm font-bold rounded-xl min-h-[48px] disabled:opacity-50 flex-shrink-0"
        >
          {busy === 'json' ? 'Exporting…' : 'Download JSON'}
        </button>
      </div>
    </section>
  )
}
